"""
app/train.py
─────────────────────────────────────────────────────────────────────────────
Weekend batch training script for the Discrete SAC vendor routing agent.
Triggered by the SAP Job Scheduling Service (or a CF one-off task).

Shadow-mode training loop:
    1. Fetch last 7 days of reviewed RLTrainingBatch records from HANA
    2. Build PyTorch tensors from (StateVector, PredictedAction, TrueAction, Reward)
    3. Run N epochs of Discrete SAC + Behavioural Cloning weight updates
    4. Save updated .pt checkpoint so the FastAPI service hot-loads it

Usage:
    python -m app.train
    python -m app.train --epochs 30 --batch-size 128 --bc-lambda 1.5
    python -m app.train --output weights/sac_agent_v2.pt --dry-run

CF one-off task (add to manifest.yml):
    tasks:
      - name: weekly-rl-training
        command: python -m app.train --epochs 25
        memory: 1G
─────────────────────────────────────────────────────────────────────────────
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Tuple

import numpy as np
import pandas as pd
import torch
from torch.utils.data import DataLoader, TensorDataset

from app.model import (
    ACTION_TO_IDX,
    ACTIONS,
    NUM_ACTIONS,
    STATE_DIM,
    SACAgent,
    encode_state_vector,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
LOG = logging.getLogger("rl.train")

# ─────────────────────────────────────────────────────────────────────────────
#  HANA data loader
# ─────────────────────────────────────────────────────────────────────────────

def fetch_weekly_batches(lookback_days: int = 7) -> pd.DataFrame:
    """
    Retrieves reviewed RLTrainingBatch records from SAP HANA Cloud.
    Only rows where REWARD != 0 are fetched (i.e., human has confirmed the
    decision so a labelled training signal exists).

    Production replacement:
    ───────────────────────
        from hdbcli import dbapi

        conn = dbapi.connect(
            address  = os.environ["HANA_HOST"],
            port     = int(os.environ["HANA_PORT"]),
            user     = os.environ["HANA_USER"],
            password = os.environ["HANA_PASSWORD"],
            encrypt  = True,
            sslTrustStore = os.environ.get("HANA_SSL_TRUST_STORE", ""),
        )
        cursor = conn.cursor()
        cursor.execute(
            f'''
            SELECT
                STATE_VECTOR,
                PREDICTED_ACTION,
                TRUE_ACTION,
                REWARD
            FROM "VENDORPORTAL"."VENDORPORTAL_RLTRAININGBATCH"
            WHERE REWARD      != 0
            AND   CREATEDAT   >= ADD_DAYS(CURRENT_DATE, -{lookback_days})
            AND   TRUE_ACTION != ''
            ORDER BY CREATEDAT DESC
            ''',
        )
        rows = cursor.fetchall()
        cursor.close()
        conn.close()

        if not rows:
            LOG.warning("[DataLoader] No labelled rows found in HANA for the lookback window.")
            return pd.DataFrame(columns=["state_vector","predicted_action","true_action","reward"])

        return pd.DataFrame(
            rows,
            columns=["state_vector", "predicted_action", "true_action", "reward"]
        )

    Args:
        lookback_days: Number of days to look back in HANA (default 7).

    Returns:
        DataFrame with columns: state_vector, predicted_action, true_action, reward
    """
    LOG.info(f"[DataLoader] Fetching {lookback_days}-day batch from HANA (STUB)…")

    rng = np.random.default_rng(seed=int(datetime.now().timestamp()) % 10_000)
    n   = 384

    rows = []
    for _ in range(n):
        risk      = float(rng.beta(2, 5) * 100)
        ai_conf   = float(rng.beta(9, 2))
        kyc_valid = bool(rng.random() > 0.12)
        sanction  = bool(rng.random() < 0.03)

        sv = {
            "ai_confidence_overall"  : round(ai_conf, 4),
            "ai_confidence_tax_id"   : round(min(ai_conf * rng.uniform(0.88, 1.05), 1.0), 4),
            "ai_confidence_account"  : round(min(ai_conf * rng.uniform(0.85, 1.05), 1.0), 4),
            "ai_missing_count"       : int(rng.poisson(0.4)),
            "kyc_tax_id_valid"       : kyc_valid,
            "kyc_provider_available" : bool(rng.random() > 0.04),
            "sanctions_match"        : sanction,
            "sanctions_risk_contrib" : round(risk * 0.35 if not sanction else risk * 0.85, 2),
            "is_high_risk_country"   : bool(rng.random() < 0.07),
            "sanctions_lists_checked": int(rng.choice([1, 2, 3])),
            "composite_risk_score"   : round(risk, 2),
            "company_name"           : None if rng.random() < 0.08 else "Stub Corp",
            "tax_id"                 : None if rng.random() < 0.10 else "US-12345678",
            "bank_account_number"    : None if rng.random() < 0.13 else "987654321012",
            "bank_swift_code"        : None if rng.random() < 0.18 else "DEUTDEDB",
        }

        # Heuristic human decision (ground-truth simulation)
        if sanction or risk > 72:
            true_action = "Auto-Reject"
        elif risk < 18 and ai_conf > 0.91 and kyc_valid and not sanction:
            true_action = "Auto-Approve"
        elif not kyc_valid or risk > 45:
            true_action = "Route-Compliance"
        elif sv["bank_account_number"] is None:
            true_action = "Route-Finance"
        else:
            true_action = rng.choice(["Route-Finance", "Route-Compliance"])

        # Agent prediction (random policy at cold-start; improves over training)
        pred_action = rng.choice(ACTIONS, p=[0.28, 0.10, 0.38, 0.16, 0.08])
        reward      = 1 if pred_action == true_action else -1

        rows.append({
            "state_vector"    : json.dumps(sv),
            "predicted_action": pred_action,
            "true_action"     : true_action,
            "reward"          : reward,
        })

    df  = pd.DataFrame(rows)
    acc = (df["reward"] == 1).mean()
    LOG.info(
        f"[DataLoader] Fetched {len(df)} labelled samples | "
        f"Cold-start accuracy: {acc:.1%} | "
        f"Action distribution:\n{df['true_action'].value_counts().to_string()}"
    )
    return df


# ─────────────────────────────────────────────────────────────────────────────
#  Tensor preparation
# ─────────────────────────────────────────────────────────────────────────────

def build_tensors(
    df: pd.DataFrame,
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    """
    Encodes the HANA DataFrame into four aligned PyTorch tensors:
        states        (N, STATE_DIM)  float32
        pred_actions  (N,)            int64
        true_actions  (N,)            int64
        rewards       (N,)            float32

    Rows with invalid StateVectors or unknown action labels are dropped
    with a warning so a single bad record never aborts the training run.
    """
    states_lst, pred_lst, true_lst, reward_lst = [], [], [], []
    n_skipped = 0

    for idx, row in df.iterrows():
        # ── Parse StateVector ──────────────────────────────────────────────
        try:
            sv = (
                json.loads(row["state_vector"])
                if isinstance(row["state_vector"], str)
                else row["state_vector"]
            )
            state_t = encode_state_vector(sv)
        except Exception as exc:
            LOG.warning(f"[DataPrep] Row {idx}: StateVector encoding failed — {exc}")
            n_skipped += 1
            continue

        # ── Validate action labels ─────────────────────────────────────────
        pred_idx = ACTION_TO_IDX.get(str(row["predicted_action"]).strip())
        true_idx = ACTION_TO_IDX.get(str(row["true_action"]).strip())

        if pred_idx is None:
            LOG.warning(
                f"[DataPrep] Row {idx}: unknown predicted_action "
                f"'{row['predicted_action']}' — skipping."
            )
            n_skipped += 1
            continue
        if true_idx is None:
            LOG.warning(
                f"[DataPrep] Row {idx}: unknown true_action "
                f"'{row['true_action']}' — skipping."
            )
            n_skipped += 1
            continue

        states_lst.append(state_t)
        pred_lst.append(pred_idx)
        true_lst.append(true_idx)
        reward_lst.append(float(row["reward"]))

    if not states_lst:
        raise RuntimeError(
            "Zero valid training samples after filtering. "
            "Check that HANA rows contain labelled (Reward != 0) data."
        )

    LOG.info(
        f"[DataPrep] {len(states_lst)} valid samples | {n_skipped} skipped"
    )

    return (
        torch.stack(states_lst),                                   # (N, S)
        torch.tensor(pred_lst,   dtype=torch.long),                # (N,)
        torch.tensor(true_lst,   dtype=torch.long),                # (N,)
        torch.tensor(reward_lst, dtype=torch.float32),             # (N,)
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Training loop
# ─────────────────────────────────────────────────────────────────────────────

def run_training_loop(
    agent        : SACAgent,
    states       : torch.Tensor,
    pred_actions : torch.Tensor,
    true_actions : torch.Tensor,
    rewards      : torch.Tensor,
    epochs       : int   = 20,
    batch_size   : int   = 64,
    bc_lambda    : float = 1.0,
    log_interval : int   = 5,
) -> dict:
    """
    Runs the Discrete SAC + Behavioural Cloning training loop.

    Args:
        agent        : Initialised SACAgent (pre-loaded with existing weights if available).
        states       : (N, STATE_DIM) tensor.
        pred_actions : (N,) agent predicted action indices.
        true_actions : (N,) human ground-truth action indices.
        rewards      : (N,) reward signals (+1 / −1 / 0).
        epochs       : Number of full passes over the dataset.
        batch_size   : Mini-batch size for SGD.
        bc_lambda    : Behavioural cloning loss coefficient λ.
        log_interval : Log every N epochs.

    Returns:
        Dict mapping metric names to lists of per-epoch mean values.
    """
    # Override agent's bc_lambda for this run
    agent.bc_lambda = bc_lambda

    dataset    = TensorDataset(states, pred_actions, true_actions, rewards)
    loader     = DataLoader(dataset, batch_size=batch_size, shuffle=True, drop_last=False)
    n_batches  = len(loader)

    metric_keys = ["loss_critic", "loss_actor", "loss_sac", "loss_bc", "alpha", "entropy"]
    history     = {k: [] for k in metric_keys}

    LOG.info(
        f"[Training] Starting {epochs} epochs | "
        f"batch_size={batch_size} | n_batches/epoch={n_batches} | λ_bc={bc_lambda}"
    )
    t_start = time.perf_counter()

    for epoch in range(1, epochs + 1):
        epoch_acc = {k: [] for k in metric_keys}

        for s_b, ap_b, at_b, r_b in loader:
            metrics = agent.update(
                states       = s_b,
                pred_actions = ap_b,
                true_actions = at_b,
                rewards      = r_b,
            )
            for k in metric_keys:
                if k in metrics:
                    epoch_acc[k].append(metrics[k])

        epoch_means = {k: float(np.mean(v)) for k, v in epoch_acc.items() if v}
        for k, v in epoch_means.items():
            history[k].append(v)

        if epoch % log_interval == 0 or epoch == 1 or epoch == epochs:
            elapsed = time.perf_counter() - t_start
            LOG.info(
                f"Epoch {epoch:>3}/{epochs} | "
                f"L_critic={epoch_means.get('loss_critic', 0):.4f} | "
                f"L_actor={epoch_means.get('loss_actor', 0):.4f}  | "
                f"L_bc={epoch_means.get('loss_bc', 0):.4f}  | "
                f"L_sac={epoch_means.get('loss_sac', 0):.4f} | "
                f"α={epoch_means.get('alpha', 0):.4f} | "
                f"H={epoch_means.get('entropy', 0):.3f} | "
                f"{elapsed:.1f}s"
            )

    total_elapsed = time.perf_counter() - t_start
    LOG.info(f"[Training] Complete in {total_elapsed:.1f}s")
    return history


# ─────────────────────────────────────────────────────────────────────────────
#  Evaluation helper (post-training accuracy check)
# ─────────────────────────────────────────────────────────────────────────────

@torch.no_grad()
def evaluate_accuracy(
    agent        : SACAgent,
    states       : torch.Tensor,
    true_actions : torch.Tensor,
) -> float:
    """
    Computes the greedy (argmax) accuracy of the trained policy against human
    ground-truth labels on the training set. Used as a sanity check to ensure
    the model hasn't diverged.
    """
    agent.actor.eval()
    probs      = agent.actor(states)
    pred_idx   = probs.argmax(dim=-1)
    accuracy   = (pred_idx == true_actions).float().mean().item()
    agent.actor.train()
    return accuracy


# ─────────────────────────────────────────────────────────────────────────────
#  Entry point
# ─────────────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Discrete SAC weekly batch training")
    p.add_argument("--epochs",       type=int,   default=20,                    help="Training epochs")
    p.add_argument("--batch-size",   type=int,   default=64,                    help="Mini-batch size")
    p.add_argument("--bc-lambda",    type=float, default=1.0,                   help="BC loss coefficient λ")
    p.add_argument("--lookback",     type=int,   default=7,                     help="HANA lookback window (days)")
    p.add_argument("--input",        type=str,   default="weights/sac_agent.pt",help="Load existing checkpoint")
    p.add_argument("--output",       type=str,   default="weights/sac_agent.pt",help="Save updated checkpoint")
    p.add_argument("--log-interval", type=int,   default=5,                     help="Log every N epochs")
    p.add_argument("--dry-run",      action="store_true",                       help="Fetch data but skip training")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    LOG.info("=" * 70)
    LOG.info(f"  Vendor Routing RL Agent — Shadow Mode Training")
    LOG.info(f"  Run time   : {datetime.now().isoformat()}")
    LOG.info(f"  Epochs     : {args.epochs} | Batch size: {args.batch_size}")
    LOG.info(f"  λ_bc       : {args.bc_lambda}")
    LOG.info(f"  Input ckpt : {args.input}")
    LOG.info(f"  Output ckpt: {args.output}")
    LOG.info("=" * 70)

    # ── 1. Fetch data from HANA ───────────────────────────────────────────────
    df = fetch_weekly_batches(lookback_days=args.lookback)
    if df.empty:
        LOG.warning("[Main] No training data returned. Exiting without updating weights.")
        sys.exit(0)

    # ── 2. Build tensors ──────────────────────────────────────────────────────
    states, pred_actions, true_actions, rewards = build_tensors(df)
    LOG.info(
        f"[Main] Tensor shapes — "
        f"states: {tuple(states.shape)}, "
        f"pred: {tuple(pred_actions.shape)}, "
        f"true: {tuple(true_actions.shape)}, "
        f"rewards: {tuple(rewards.shape)}"
    )

    if args.dry_run:
        LOG.info("[Main] --dry-run: skipping training and checkpoint save.")
        sys.exit(0)

    # ── 3. Initialise agent and load existing weights ─────────────────────────
    agent = SACAgent(bc_lambda=args.bc_lambda)
    if os.path.exists(args.input):
        try:
            agent.load(args.input)
            LOG.info(f"[Main] Resumed from checkpoint: {args.input}")
        except Exception as exc:
            LOG.error(
                f"[Main] Failed to load checkpoint '{args.input}': {exc}. "
                f"Training from random initialisation."
            )
    else:
        LOG.warning(f"[Main] No checkpoint at '{args.input}'. Training from scratch.")

    # ── 4. Training loop ──────────────────────────────────────────────────────
    history = run_training_loop(
        agent        = agent,
        states       = states,
        pred_actions = pred_actions,
        true_actions = true_actions,
        rewards      = rewards,
        epochs       = args.epochs,
        batch_size   = args.batch_size,
        bc_lambda    = args.bc_lambda,
        log_interval = args.log_interval,
    )

    # ── 5. Post-training accuracy ─────────────────────────────────────────────
    acc = evaluate_accuracy(agent, states, true_actions)
    LOG.info(f"[Main] Post-training greedy accuracy (train set): {acc:.1%}")

    # Warn if the model appears to have diverged (accuracy worse than random)
    random_baseline = 1.0 / NUM_ACTIONS
    if acc < random_baseline:
        LOG.error(
            f"[Main] Post-training accuracy {acc:.1%} < random baseline {random_baseline:.1%}. "
            f"Model may have diverged — checkpoint NOT saved. Investigate gradients and lr."
        )
        sys.exit(1)

    # ── 6. Save updated checkpoint ────────────────────────────────────────────
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Atomic write: save to a temp file then rename so the FastAPI service never
    # sees a partially written checkpoint during hot-reload.
    tmp_path = output_path.with_suffix(".tmp.pt")
    agent.save(str(tmp_path))
    tmp_path.rename(output_path)

    LOG.info(f"[Main] ✓ Checkpoint saved → {output_path}")
    LOG.info(
        f"[Main] Final metrics — "
        f"L_critic={history['loss_critic'][-1]:.4f} | "
        f"L_bc={history['loss_bc'][-1]:.4f} | "
        f"α={history['alpha'][-1]:.4f} | "
        f"H={history['entropy'][-1]:.3f}"
    )


if __name__ == "__main__":
    main()
