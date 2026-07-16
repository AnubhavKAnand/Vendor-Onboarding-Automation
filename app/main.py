"""
app/main.py
─────────────────────────────────────────────────────────────────────────────
FastAPI inference server for the Vendor Routing RL Agent.

Endpoints:
    POST /predict  — returns PredictedAction + confidence for a StateVector
    GET  /health   — liveness + model-loaded status for CF health checks

Deployment on SAP BTP Cloud Foundry:
    Procfile:  web: uvicorn app.main:app --host 0.0.0.0 --port $PORT
    Memory:    minimum 768 MB (PyTorch CPU baseline ~650 MB)

Required environment variables:
    MODEL_PATH      — path to the .pt checkpoint (default: weights/sac_agent.pt)
    MODEL_VERSION   — human-readable version tag injected at deploy time
    RL_SERVICE_PORT — overrides uvicorn port if needed (set via CF manifest)
─────────────────────────────────────────────────────────────────────────────
"""

import asyncio
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

import torch
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.model import (
    ACTIONS,
    IDX_TO_ACTION,
    NUM_ACTIONS,
    STATE_DIM,
    SACAgent,
    encode_state_vector,
)

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
LOG = logging.getLogger("rl.api")

# ── Configuration ─────────────────────────────────────────────────────────────
MODEL_PATH    : str = os.environ.get("MODEL_PATH",    "weights/sac_agent.pt")
MODEL_VERSION : str = os.environ.get("MODEL_VERSION", "v1.0.0-shadow")

# ── Singleton model state ─────────────────────────────────────────────────────
# Protected by a reentrant lock so the weights can be hot-reloaded during
# a training cycle without serving stale or partially-loaded weights.
_agent       : Optional[SACAgent] = None
_model_lock  : threading.RLock    = threading.RLock()
_load_time   : Optional[float]    = None
_load_error  : Optional[str]      = None


# ─────────────────────────────────────────────────────────────────────────────
#  Lifespan: model loading on startup
# ─────────────────────────────────────────────────────────────────────────────

def _load_model_from_disk() -> None:
    """
    Synchronous weight-loading routine. Called once at startup and may be
    called again by a /reload endpoint (Phase 4 addition) after training.
    """
    global _agent, _load_time, _load_error

    with _model_lock:
        candidate = SACAgent(device="cpu")

        if os.path.exists(MODEL_PATH):
            try:
                candidate.load(MODEL_PATH)
                LOG.info(f"[Startup] Model weights loaded from '{MODEL_PATH}'.")
                _load_error = None
            except Exception as exc:
                _load_error = str(exc)
                LOG.error(
                    f"[Startup] Failed to load weights from '{MODEL_PATH}': {exc}. "
                    f"Falling back to randomly initialised network."
                )
        else:
            LOG.warning(
                f"[Startup] No checkpoint found at '{MODEL_PATH}'. "
                f"Serving randomly initialised weights — predictions are non-informative "
                f"until the first training run completes."
            )

        # Always switch to eval mode for inference
        candidate.actor.eval()
        _agent     = candidate
        _load_time = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Run model loading in a thread pool so it does not block the event loop
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_model_from_disk)
    LOG.info(f"[Startup] RL inference service ready — model version: {MODEL_VERSION}")
    yield
    LOG.info("[Shutdown] RL inference service shutting down.")


# ─────────────────────────────────────────────────────────────────────────────
#  FastAPI application
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title       = "Vendor Routing RL Agent — Shadow Mode",
    description = (
        "Discrete SAC inference service for vendor workflow routing. "
        "Operating in read-only shadow mode: predictions are advisory only; "
        "humans make all final decisions."
    ),
    version     = MODEL_VERSION,
    lifespan    = lifespan,
)


# ─────────────────────────────────────────────────────────────────────────────
#  Pydantic schemas
# ─────────────────────────────────────────────────────────────────────────────

class PredictRequest(BaseModel):
    vendor_id    : str               = Field(..., description="Vendor UUID from SAP HANA")
    state_vector : Dict[str, Any]    = Field(..., description="Phase 2 enriched StateVector JSON")


class PredictResponse(BaseModel):
    vendor_id            : str
    predicted_action     : str                = Field(..., description="Greedy argmax action name")
    action_index         : int                = Field(..., ge=0, lt=NUM_ACTIONS)
    confidence           : float              = Field(..., ge=0.0, le=1.0)
    action_probabilities : Dict[str, float]   = Field(..., description="Full softmax distribution")
    model_version        : str
    inference_time_ms    : float              = Field(..., description="Forward-pass wall time")


class HealthResponse(BaseModel):
    status           : str
    model_loaded     : bool
    model_version    : str
    weights_path     : str
    weights_exist    : bool
    load_error       : Optional[str]
    uptime_seconds   : Optional[float]
    state_dim        : int   = STATE_DIM
    num_actions      : int   = NUM_ACTIONS
    actions          : list  = ACTIONS


# ─────────────────────────────────────────────────────────────────────────────
#  Global exception handler
# ─────────────────────────────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    LOG.error(f"[UnhandledException] {request.url.path}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": f"Internal server error: {str(exc)}"},
    )


# ─────────────────────────────────────────────────────────────────────────────
#  POST /predict
# ─────────────────────────────────────────────────────────────────────────────

@app.post(
    "/predict",
    response_model=PredictResponse,
    status_code=status.HTTP_200_OK,
    summary="Get RL routing prediction for a vendor",
)
async def predict(request: PredictRequest) -> PredictResponse:
    """
    Accepts a Phase 2 StateVector, encodes it into a tensor, runs a forward
    pass through the SAC Actor network, and returns the greedy routing action
    with its probability distribution.

    HTTP 500 is returned if tensor encoding or model inference fails so the
    CAPM caller can distinguish a client error (400) from a model failure (500)
    and degrade gracefully.
    """
    if _agent is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Model is not yet loaded. Retry in a moment.",
        )

    # ── Step 1: encode StateVector into a float tensor ────────────────────────
    try:
        state_tensor = encode_state_vector(request.state_vector)
    except (KeyError, ValueError, TypeError) as enc_err:
        LOG.error(
            f"[/predict] State encoding failed for vendor '{request.vendor_id}': {enc_err}"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"StateVector encoding failed: {str(enc_err)}",
        )

    # ── Step 2: forward pass through Actor ────────────────────────────────────
    t_start = time.perf_counter()
    try:
        with _model_lock:
            action_idx, confidence, prob_dict = _agent.actor.predict(state_tensor)
    except Exception as inf_err:
        LOG.error(
            f"[/predict] Model inference failed for vendor '{request.vendor_id}': {inf_err}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Model inference failed: {str(inf_err)}",
        )
    elapsed_ms = (time.perf_counter() - t_start) * 1000

    predicted_action = IDX_TO_ACTION[action_idx]

    LOG.info(
        f"[/predict] vendor={request.vendor_id} | "
        f"action={predicted_action} | "
        f"confidence={confidence:.4f} | "
        f"{elapsed_ms:.2f}ms"
    )

    return PredictResponse(
        vendor_id            = request.vendor_id,
        predicted_action     = predicted_action,
        action_index         = action_idx,
        confidence           = round(confidence, 6),
        action_probabilities = prob_dict,
        model_version        = MODEL_VERSION,
        inference_time_ms    = round(elapsed_ms, 3),
    )


# ─────────────────────────────────────────────────────────────────────────────
#  GET /health
# ─────────────────────────────────────────────────────────────────────────────

@app.get(
    "/health",
    response_model=HealthResponse,
    status_code=status.HTTP_200_OK,
    summary="Liveness and model-state check",
)
async def health() -> HealthResponse:
    """
    CF health-check endpoint. Returns 200 if the service is running.
    `model_loaded` indicates whether the Actor has usable weights;
    `load_error` surfaces any checkpoint-loading exception for ops visibility.
    """
    uptime = (time.time() - _load_time) if _load_time else None
    return HealthResponse(
        status         = "healthy",
        model_loaded   = _agent is not None,
        model_version  = MODEL_VERSION,
        weights_path   = MODEL_PATH,
        weights_exist  = os.path.exists(MODEL_PATH),
        load_error     = _load_error,
        uptime_seconds = round(uptime, 1) if uptime is not None else None,
    )
