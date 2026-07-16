"""
app/model.py
─────────────────────────────────────────────────────────────────────────────
Discrete Soft Actor-Critic (SAC) network definitions for the vendor routing
RL agent operating in 6-month Shadow Mode.

Action space  (5 discrete):
    0 → Auto-Approve      low-risk, fully enriched, KYC clean
    1 → Auto-Reject       sanctions hit, extreme risk, critical missing fields
    2 → Route-Compliance  regulatory / KYC ambiguity
    3 → Route-Finance     bank account / payment verification required
    4 → Route-Both        dual-track: compliance + finance review

State space: 16 normalised numeric features extracted from the Phase 2 StateVector.

Architecture:
    Actor    → MLP(16, 128, 128, 5) + Softmax  (categorical policy)
    Critic×2 → MLP(16, 128, 128, 5)             (Q-value per action)
    Target×2 → soft-copied Critics               (stable Bellman targets)
    log α    → learnable scalar                  (entropy temperature)

Reference: Christodoulou (2019) — Soft Actor-Critic for Discrete Action Settings
─────────────────────────────────────────────────────────────────────────────
"""

import logging
from typing import Dict, Any, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.distributions import Categorical

LOG = logging.getLogger("rl.model")

# ── Action space ──────────────────────────────────────────────────────────────
ACTIONS: list[str] = [
    "Auto-Approve",
    "Auto-Reject",
    "Route-Compliance",
    "Route-Finance",
    "Route-Both",
]
NUM_ACTIONS   : int = len(ACTIONS)
ACTION_TO_IDX : Dict[str, int] = {a: i for i, a in enumerate(ACTIONS)}
IDX_TO_ACTION : Dict[int, str] = {i: a for i, a in enumerate(ACTIONS)}

# ── State space ───────────────────────────────────────────────────────────────
STATE_DIM: int = 16   # must equal len(FEATURE_KEYS)

FEATURE_KEYS: list[str] = [
    # LLM confidence signals
    "ai_confidence_overall",      # float  0–1
    "ai_confidence_tax_id",       # float  0–1
    "ai_confidence_account",      # float  0–1
    "ai_missing_count_norm",      # int/10  0–1  (derived)
    # KYC signals
    "kyc_tax_id_valid",           # tri-valued: +1 / 0 / −1 (null = indeterminate)
    "kyc_provider_available",     # bool → float
    # Sanctions signals
    "sanctions_match",            # tri-valued: +1 / 0 / −1
    "sanctions_risk_norm",        # float/100  0–1
    "is_high_risk_country",       # bool → float
    "sanctions_lists_norm",       # int/5  0–1
    # Composite risk
    "composite_risk_norm",        # float/100  0–1
    # Derived field-presence indicators
    "has_company_name",           # 1 if not null
    "has_tax_id",                 # 1 if not null
    "has_bank_account_number",    # 1 if not null
    "has_swift_code",             # 1 if not null
    "is_high_risk_composite",     # 1 if composite_risk_score > 50
]

assert len(FEATURE_KEYS) == STATE_DIM, (
    f"FEATURE_KEYS length {len(FEATURE_KEYS)} must equal STATE_DIM {STATE_DIM}"
)


# ─────────────────────────────────────────────────────────────────────────────
#  State encoder
# ─────────────────────────────────────────────────────────────────────────────

def encode_state_vector(sv: Dict[str, Any]) -> torch.Tensor:
    """
    Convert a raw Phase 2 StateVector dict into a normalised float32 Tensor
    of shape (STATE_DIM,).

    Null / indeterminate boolean fields are mapped to −1.0 so the network
    can distinguish between "unknown" and "explicitly false".

    Args:
        sv: Raw StateVector dict produced by the Phase 2 enrichment pipeline.

    Returns:
        Tensor of shape (16,) with all values approximately in [−1, 1].

    Raises:
        ValueError: if the encoded vector length does not equal STATE_DIM.
    """

    def _tri(val) -> float:
        """True → 1.0 | False → 0.0 | None → −1.0"""
        if val is None:
            return -1.0
        return 1.0 if bool(val) else 0.0

    def _f(key: str, default: float = 0.0) -> float:
        v = sv.get(key, default)
        return float(v) if v is not None else default

    composite = _f("composite_risk_score", 0.0)

    features: list[float] = [
        _f("ai_confidence_overall"),
        _f("ai_confidence_tax_id"),
        _f("ai_confidence_account"),
        min(_f("ai_missing_count"), 10.0) / 10.0,         # normalise 0–10 → 0–1
        _tri(sv.get("kyc_tax_id_valid")),
        1.0 if sv.get("kyc_provider_available") else 0.0,
        _tri(sv.get("sanctions_match")),
        min(_f("sanctions_risk_contrib"), 100.0) / 100.0, # normalise 0–100 → 0–1
        1.0 if sv.get("is_high_risk_country") else 0.0,
        min(_f("sanctions_lists_checked"), 5.0) / 5.0,   # normalise 0–5 → 0–1
        composite / 100.0,                                 # normalise 0–100 → 0–1
        # Presence indicators
        0.0 if sv.get("company_name")        is None else 1.0,
        0.0 if sv.get("tax_id")              is None else 1.0,
        0.0 if sv.get("bank_account_number") is None else 1.0,
        0.0 if sv.get("bank_swift_code")     is None else 1.0,
        1.0 if composite > 50.0 else 0.0,
    ]

    if len(features) != STATE_DIM:
        raise ValueError(
            f"Encoded feature vector length {len(features)} ≠ STATE_DIM {STATE_DIM}. "
            f"Check FEATURE_KEYS and encode_state_vector() are in sync."
        )

    return torch.tensor(features, dtype=torch.float32)


# ─────────────────────────────────────────────────────────────────────────────
#  Shared MLP backbone
# ─────────────────────────────────────────────────────────────────────────────

class _MLP(nn.Module):
    """
    Two-hidden-layer MLP with LayerNorm + ReLU.
    LayerNorm is used instead of BatchNorm because batch sizes during inference
    are always 1, which makes BatchNorm statistics unreliable.
    """

    def __init__(self, in_dim: int, hidden_dim: int, out_dim: int):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, out_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


# ─────────────────────────────────────────────────────────────────────────────
#  Actor  (categorical policy π(a|s))
# ─────────────────────────────────────────────────────────────────────────────

class Actor(nn.Module):
    """
    Discrete SAC Actor. Outputs a categorical probability distribution over
    NUM_ACTIONS routing actions via softmax.

    forward()   → probability vector (inference + training)
    evaluate()  → sampled action, log-prob, probabilities (training)
    predict()   → greedy action, confidence, full prob dict (FastAPI endpoint)
    """

    def __init__(
        self,
        state_dim: int   = STATE_DIM,
        action_dim: int  = NUM_ACTIONS,
        hidden_dim: int  = 128,
    ):
        super().__init__()
        self.backbone = _MLP(state_dim, hidden_dim, action_dim)

    def forward(self, state: torch.Tensor) -> torch.Tensor:
        """Returns softmax probabilities. Shape: (..., action_dim)."""
        return F.softmax(self.backbone(state), dim=-1)

    def evaluate(
        self, state: torch.Tensor
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Stochastic evaluation for training.
        Returns:
            action      : sampled action index, shape (B,)
            log_prob    : log π(action|state), shape (B,)
            probs       : full probability vector, shape (B, A)
        """
        probs   = self.forward(state)
        dist    = Categorical(probs)
        action  = dist.sample()
        log_p   = dist.log_prob(action)
        return action, log_p, probs

    @torch.no_grad()
    def predict(
        self, state: torch.Tensor
    ) -> Tuple[int, float, Dict[str, float]]:
        """
        Greedy deterministic inference (argmax). Used by the FastAPI endpoint.
        Returns:
            action_idx  : int index of the highest-probability action
            confidence  : probability of the chosen action (scalar)
            prob_dict   : mapping {action_name: probability} for all 5 actions
        """
        self.eval()
        probs       = self.forward(state.unsqueeze(0)).squeeze(0)   # (A,)
        action_idx  = int(probs.argmax().item())
        confidence  = float(probs[action_idx].item())
        prob_dict   = {
            ACTIONS[i]: round(float(p.item()), 6)
            for i, p in enumerate(probs)
        }
        return action_idx, confidence, prob_dict


# ─────────────────────────────────────────────────────────────────────────────
#  Critic  (action-value function Q(s, a))
# ─────────────────────────────────────────────────────────────────────────────

class Critic(nn.Module):
    """
    Discrete SAC Critic. Outputs a Q-value for every action simultaneously.
    Shape: (..., action_dim). No activation on the output layer.

    Two independent Critic instances (Q1, Q2) are used for double-Q clipping
    to prevent overestimation of Q-values during the Bellman update.
    """

    def __init__(
        self,
        state_dim: int   = STATE_DIM,
        action_dim: int  = NUM_ACTIONS,
        hidden_dim: int  = 128,
    ):
        super().__init__()
        self.backbone = _MLP(state_dim, hidden_dim, action_dim)

    def forward(self, state: torch.Tensor) -> torch.Tensor:
        return self.backbone(state)   # raw Q-values; no activation


# ─────────────────────────────────────────────────────────────────────────────
#  SACAgent — unified wrapper for training and inference
# ─────────────────────────────────────────────────────────────────────────────

class SACAgent:
    """
    Wraps Actor + two Critics + soft target Critics + learnable entropy
    temperature (log α) into a single training and inference interface.

    Shadow-mode specifics:
    - Episodes are treated as terminal: no next-state Bellman bootstrapping.
      Q_target(s, a_pred) = r directly, since each vendor decision is
      independent and we have no transition dynamics from HANA batch data.
    - Behavioral Cloning (BC) loss is added to the Actor objective to
      accelerate convergence toward human decisions via direct imitation.
    - Positive-reward samples (agent was correct) receive an upweighted BC
      gradient to reinforce already-correct predictions.
    """

    def __init__(
        self,
        state_dim      : int   = STATE_DIM,
        action_dim     : int   = NUM_ACTIONS,
        hidden_dim     : int   = 128,
        lr_actor       : float = 3e-4,
        lr_critic      : float = 3e-4,
        lr_alpha       : float = 3e-4,
        gamma          : float = 0.99,
        tau            : float = 5e-3,
        bc_lambda      : float = 1.0,
        target_entropy : float | None = None,
        device         : str   = "cpu",
    ):
        self.device     = torch.device(device)
        self.gamma      = gamma
        self.tau        = tau
        self.bc_lambda  = bc_lambda
        self.action_dim = action_dim
        # Target entropy: 98% of maximum discrete entropy (log N)
        self.target_entropy = (
            target_entropy
            if target_entropy is not None
            else float(0.98 * np.log(action_dim))
        )

        # ── Networks ──────────────────────────────────────────────────────────
        self.actor   = Actor(state_dim, action_dim, hidden_dim).to(self.device)
        self.critic1 = Critic(state_dim, action_dim, hidden_dim).to(self.device)
        self.critic2 = Critic(state_dim, action_dim, hidden_dim).to(self.device)
        self.target1 = Critic(state_dim, action_dim, hidden_dim).to(self.device)
        self.target2 = Critic(state_dim, action_dim, hidden_dim).to(self.device)

        # Hard-copy critics → targets at initialisation
        self.target1.load_state_dict(self.critic1.state_dict())
        self.target2.load_state_dict(self.critic2.state_dict())
        for p in (*self.target1.parameters(), *self.target2.parameters()):
            p.requires_grad = False

        # ── Learnable log α (entropy temperature) ─────────────────────────────
        self.log_alpha = torch.tensor(
            np.log(0.2), requires_grad=True, dtype=torch.float32, device=self.device
        )

        # ── Optimisers ────────────────────────────────────────────────────────
        self.opt_actor  = torch.optim.Adam(self.actor.parameters(),  lr=lr_actor)
        self.opt_critic = torch.optim.Adam(
            list(self.critic1.parameters()) + list(self.critic2.parameters()),
            lr=lr_critic,
        )
        self.opt_alpha  = torch.optim.Adam([self.log_alpha], lr=lr_alpha)

    @property
    def alpha(self) -> torch.Tensor:
        return self.log_alpha.exp()

    # ── Training update ───────────────────────────────────────────────────────

    def update(
        self,
        states       : torch.Tensor,   # (B, STATE_DIM)
        pred_actions : torch.Tensor,   # (B,) agent's predicted action indices
        true_actions : torch.Tensor,   # (B,) human's ground-truth action indices
        rewards      : torch.Tensor,   # (B,) +1 match, −1 mismatch, 0 pending
    ) -> Dict[str, float]:
        """
        Single SAC + Behavioral Cloning update step.

        Critic update (double-Q, terminal Bellman):
            Q_target(s, a_pred) = r   (no next-state; terminal episode)
            Lc = MSE(Q1(s,a_pred), r) + MSE(Q2(s,a_pred), r)

        Actor update (SAC + BC):
            L_SAC = Σ_a π(a|s) * (α * log π(a|s) − min(Q1,Q2)(s,a))   [entropy-regularised]
            L_BC  = −Σ w_r * log π(a_true|s)                            [imitation; w_r=1.5 if r>0]
            L_actor = L_SAC + λ * L_BC

        Alpha update:
            L_α = −log_α * (H(π) − target_H)

        Returns:
            Dict of scalar loss components for logging.
        """
        B = states.size(0)
        s  = states.to(self.device)
        ap = pred_actions.to(self.device)
        at = true_actions.to(self.device)
        r  = rewards.to(self.device)

        # ── Critic update ─────────────────────────────────────────────────────
        # Terminal-episode Bellman: Q_target = r (no next-state term)
        with torch.no_grad():
            # Soft V(s) for completeness — using current targets for stability
            next_probs    = self.actor(s)                        # (B, A)
            next_log_prob = torch.log(next_probs + 1e-8)        # (B, A)
            q1_next = self.target1(s)                            # (B, A)
            q2_next = self.target2(s)                            # (B, A)
            v_next  = (next_probs * (
                torch.min(q1_next, q2_next) - self.alpha.detach() * next_log_prob
            )).sum(dim=-1)                                        # (B,)
            q_target = r + self.gamma * v_next                   # (B,)

        # Q-values at the agent's predicted actions
        q1_a = self.critic1(s).gather(1, ap.unsqueeze(1)).squeeze(1)  # (B,)
        q2_a = self.critic2(s).gather(1, ap.unsqueeze(1)).squeeze(1)  # (B,)

        loss_c1     = F.mse_loss(q1_a, q_target)
        loss_c2     = F.mse_loss(q2_a, q_target)
        loss_critic = loss_c1 + loss_c2

        self.opt_critic.zero_grad()
        loss_critic.backward()
        torch.nn.utils.clip_grad_norm_(
            list(self.critic1.parameters()) + list(self.critic2.parameters()),
            max_norm=1.0,
        )
        self.opt_critic.step()

        # ── Actor update ──────────────────────────────────────────────────────
        probs     = self.actor(s)                                # (B, A)
        log_probs = torch.log(probs + 1e-8)                     # (B, A)

        with torch.no_grad():
            q_min = torch.min(self.critic1(s), self.critic2(s))  # (B, A)

        # SAC objective: maximise E_π[Q(s,a)] + α * H(π(·|s))
        # Summed over actions (discrete SAC: expectation taken analytically)
        loss_sac = (probs * (self.alpha.detach() * log_probs - q_min)).sum(dim=-1).mean()

        # Behavioural Cloning: maximise log π(a_true|s), weighted by reward signal
        # +reward → upweight (agent was right → reinforce)
        # −reward → standard weight (correct toward human decision)
        log_prob_true = log_probs.gather(1, at.unsqueeze(1)).squeeze(1)  # (B,)
        bc_weights    = torch.where(r > 0,
                                    torch.full_like(r, 1.5),
                                    torch.ones_like(r))                   # (B,)
        loss_bc       = -(bc_weights * log_prob_true).mean()

        loss_actor = loss_sac + self.bc_lambda * loss_bc

        self.opt_actor.zero_grad()
        loss_actor.backward()
        torch.nn.utils.clip_grad_norm_(self.actor.parameters(), max_norm=1.0)
        self.opt_actor.step()

        # ── Entropy temperature update ────────────────────────────────────────
        with torch.no_grad():
            probs_new = self.actor(s)
            entropy   = -(probs_new * torch.log(probs_new + 1e-8)).sum(dim=-1)  # (B,)

        loss_alpha = -(self.log_alpha * (entropy - self.target_entropy).detach()).mean()

        self.opt_alpha.zero_grad()
        loss_alpha.backward()
        self.opt_alpha.step()

        # ── Soft-update target networks ───────────────────────────────────────
        self._soft_update(self.critic1, self.target1)
        self._soft_update(self.critic2, self.target2)

        return {
            "loss_critic": loss_critic.item(),
            "loss_actor" : loss_actor.item(),
            "loss_sac"   : loss_sac.item(),
            "loss_bc"    : loss_bc.item(),
            "loss_alpha" : loss_alpha.item(),
            "alpha"      : self.alpha.item(),
            "entropy"    : entropy.mean().item(),
        }

    def _soft_update(self, source: nn.Module, target: nn.Module) -> None:
        """Polyak averaging: θ_target ← τ*θ_source + (1−τ)*θ_target"""
        for sp, tp in zip(source.parameters(), target.parameters()):
            tp.data.copy_(self.tau * sp.data + (1.0 - self.tau) * tp.data)

    # ── Checkpoint I/O ────────────────────────────────────────────────────────

    def save(self, path: str) -> None:
        """Save all network weights and optimizer states to a .pt checkpoint."""
        torch.save(
            {
                "actor"     : self.actor.state_dict(),
                "critic1"   : self.critic1.state_dict(),
                "critic2"   : self.critic2.state_dict(),
                "target1"   : self.target1.state_dict(),
                "target2"   : self.target2.state_dict(),
                "log_alpha" : self.log_alpha.data,
                "metadata"  : {
                    "state_dim"    : STATE_DIM,
                    "action_dim"   : NUM_ACTIONS,
                    "actions"      : ACTIONS,
                },
            },
            path,
        )
        LOG.info(f"[SACAgent] Checkpoint saved → {path}")

    def load(self, path: str) -> None:
        """Load weights from a .pt checkpoint. Validates action/state dims."""
        ckpt = torch.load(path, map_location=self.device)

        meta = ckpt.get("metadata", {})
        if meta.get("state_dim") and meta["state_dim"] != STATE_DIM:
            raise ValueError(
                f"Checkpoint state_dim={meta['state_dim']} "
                f"does not match current STATE_DIM={STATE_DIM}"
            )
        if meta.get("action_dim") and meta["action_dim"] != NUM_ACTIONS:
            raise ValueError(
                f"Checkpoint action_dim={meta['action_dim']} "
                f"does not match current NUM_ACTIONS={NUM_ACTIONS}"
            )

        self.actor.load_state_dict(ckpt["actor"])
        self.critic1.load_state_dict(ckpt["critic1"])
        self.critic2.load_state_dict(ckpt["critic2"])
        self.target1.load_state_dict(ckpt["target1"])
        self.target2.load_state_dict(ckpt["target2"])
        self.log_alpha.data.copy_(ckpt["log_alpha"])

        # Ensure inference mode after load
        self.actor.eval()
        self.critic1.eval()
        self.critic2.eval()

        LOG.info(f"[SACAgent] Checkpoint loaded ← {path} (α={self.alpha.item():.4f})")
