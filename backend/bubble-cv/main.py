"""
Bubble Game CV Service
======================
FastAPI microservice that analyses camera frames for gaze / attention
during the autism-screening bubble game.

Uses MediaPipe Face Mesh (with iris refinement) to estimate where
the child is looking, then maps that onto the bubble screen layout.

Run:
    uvicorn main:app --host 0.0.0.0 --port 8001 --reload
"""

import base64
import logging
from typing import List, Optional

import cv2
import mediapipe as mp
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import threading
import time
from collections import deque

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="Bubble Game CV Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── MediaPipe setup ───────────────────────────────────────────────────────────
mp_face_mesh = mp.solutions.face_mesh

# Create a single FaceMesh instance at startup and reuse it for all requests.
# This avoids re-initializing MediaPipe for every frame which is extremely expensive.
face_mesh_instance = None
face_mesh_lock = threading.Lock()


@app.on_event("startup")
def startup_event():
    global face_mesh_instance
    try:
        # Use dynamic (non-static) mode for continuous frames for better tracking
        face_mesh_instance = mp_face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.45,
            min_tracking_confidence=0.45,
        )
        logger.info("Initialized global MediaPipe FaceMesh instance")
    except Exception as e:
        logger.exception("Failed to initialize FaceMesh: %s", e)


@app.on_event("shutdown")
def shutdown_event():
    global face_mesh_instance
    try:
        if face_mesh_instance is not None:
            face_mesh_instance.close()
            face_mesh_instance = None
            logger.info("Closed global FaceMesh instance")
    except Exception:
        pass

# ── Per-session smoothing / state ───────────────────────────────────────────
# Stores small history and previous smoothed gaze per sessionId so multiple
# concurrent sessions don't mix their temporal smoothing state.
MIN_INTERVAL_SEC = 0.25  # minimum seconds between processed frames per session (rate limit)
session_states = {}
# Configuration
SMOOTHING_ALPHA = 0.7  # weight for previous value in exponential smoothing
GAZE_HISTORY_LEN = 8
SESSION_PRUNE_SECONDS = 60.0

def prune_session_states():
    now = time.time()
    to_delete = [k for k, v in session_states.items() if now - v.get("last_seen", 0) > SESSION_PRUNE_SECONDS]
    for k in to_delete:
        del session_states[k]

# Iris landmark indices (MediaPipe Face Mesh with refine_landmarks=True)
LEFT_IRIS  = [474, 475, 476, 477]
RIGHT_IRIS = [469, 470, 471, 472]

# Eye-corner indices used for normalising iris position
L_CORNER_OUTER = 33
L_CORNER_INNER = 133
R_CORNER_INNER = 362
R_CORNER_OUTER = 263


# ── Request / Response schemas ────────────────────────────────────────────────
class BubblePosition(BaseModel):
    bubbleIndex: int
    target: str        # "face" | "pattern"
    centerX: float
    centerY: float


class FrameRequest(BaseModel):
    frameBase64: str
    timestampMs: int
    trialType: str          # "pattern" | "face" | "compete"
    phaseId: str
    trialNumber: int
    screenWidth: float
    screenHeight: float
    bubblePositions: Optional[List[BubblePosition]] = None
    sessionId: Optional[str] = None


class FrameResponse(BaseModel):
    faceDetected: bool
    gazeX: Optional[float] = None
    gazeY: Optional[float] = None
    gazeDirection: Optional[str] = None   # "left"|"right"|"center"|"up"|"down"
    attentionTarget: Optional[str] = None # "face"|"pattern"|"none"
    confidence: float = 0.0
    headPoseYaw: Optional[float] = None
    headPosePitch: Optional[float] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def decode_image(b64: str) -> Optional[np.ndarray]:
    """Decode base64 (with or without data-URL prefix) → BGR ndarray."""
    try:
        if "," in b64:
            b64 = b64.split(",", 1)[1]
        raw = base64.b64decode(b64)
        arr = np.frombuffer(raw, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img
    except Exception as exc:
        logger.warning("decode_image failed: %s", exc)
        return None


def iris_gaze_ratio(landmarks, img_w: int, img_h: int):
    """
    Compute normalised horizontal gaze ratio per eye.
    Returns (left_ratio, right_ratio) each in [0,1]:
      ~0.3 → looking right (from camera view)
      ~0.5 → centre
      ~0.7 → looking left
    Returns (None, None) on failure.
    """
    try:
        def pt(idx):
            l = landmarks[idx]
            return np.array([l.x * img_w, l.y * img_h], dtype=np.float32)

        left_iris_pts  = np.array([pt(i) for i in LEFT_IRIS])
        right_iris_pts = np.array([pt(i) for i in RIGHT_IRIS])

        l_iris  = left_iris_pts.mean(axis=0)
        r_iris  = right_iris_pts.mean(axis=0)

        l_outer = pt(L_CORNER_OUTER);  l_inner = pt(L_CORNER_INNER)
        r_inner = pt(R_CORNER_INNER);  r_outer = pt(R_CORNER_OUTER)

        l_width = max(np.linalg.norm(l_inner - l_outer), 1.0)
        r_width = max(np.linalg.norm(r_outer - r_inner), 1.0)

        l_ratio = (l_iris[0] - l_outer[0]) / l_width
        r_ratio = (r_iris[0] - r_inner[0]) / r_width

        return l_ratio, r_ratio
    except Exception:
        return None, None


def estimate_gaze_normalised(landmarks, img_w, img_h):
    """
    Returns (gaze_x_norm, gaze_y_norm):
      gaze_x_norm: -1 = far left of screen, +1 = far right
      gaze_y_norm: -1 = up, +1 = down
    """
    l_ratio, r_ratio = iris_gaze_ratio(landmarks, img_w, img_h)
    if l_ratio is None:
        return None, None

    # Average across eyes; centre is ~0.5 → map to [-1, 1]
    avg_ratio = (l_ratio + r_ratio) / 2.0
    gaze_x = (avg_ratio - 0.5) * 2.0  # positive = right in camera

    # Vertical: use nose-to-eye angle as rough pitch proxy
    nose_y   = landmarks[1].y
    eye_y    = (landmarks[LEFT_IRIS[0]].y + landmarks[RIGHT_IRIS[0]].y) / 2.0
    gaze_y   = (eye_y - nose_y) * 4.0   # scale so ±0.3 covers normal range

    return float(gaze_x), float(gaze_y)


def gaze_to_screen(gaze_x_norm, gaze_y_norm,
                   face_cx, face_cy, img_w, img_h,
                   screen_w, screen_h):
    """
    Map normalised gaze vector + face position → screen pixel coordinates.
    Front camera is mirrored, so horizontal axis is flipped.
    """
    face_x_frac = face_cx / img_w   # [0,1] in image space
    face_y_frac = face_cy / img_h

    # Flip x for front camera mirroring
    screen_x = (1.0 - face_x_frac) * screen_w - gaze_x_norm * screen_w * 0.35
    screen_y = face_y_frac * screen_h           + gaze_y_norm * screen_h * 0.25

    return (
        float(max(0, min(screen_w, screen_x))),
        float(max(0, min(screen_h, screen_y))),
    )


def classify_direction(gx, gy) -> str:
    if gx is None:
        return "unknown"
    if abs(gx) < 0.18 and abs(gy) < 0.18:
        return "center"
    if abs(gx) >= abs(gy):
        return "right" if gx > 0 else "left"
    return "down" if gy > 0 else "up"


def nearest_bubble_target(sx, sy, bubbles: List[BubblePosition],
                           hit_radius: float = 90.0) -> str:
    best_dist = float("inf")
    best_target = "none"
    for b in bubbles:
        d = ((sx - b.centerX) ** 2 + (sy - b.centerY) ** 2) ** 0.5
        if d < best_dist:
            best_dist = d
            best_target = b.target
    return best_target if best_dist <= hit_radius else "none"


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "bubble-cv", "version": "1.0.0"}


@app.post("/analyze-frame", response_model=FrameResponse)
async def analyze_frame(req: FrameRequest):
    img = decode_image(req.frameBase64)
    if img is None:
        raise HTTPException(status_code=400, detail="Cannot decode image.")

    img_h, img_w = img.shape[:2]
    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    # Use the global face_mesh_instance when available to avoid per-request init.
    results = None
    try:
        if face_mesh_instance is not None:
            # protect process calls with a lock for thread-safety
            with face_mesh_lock:
                results = face_mesh_instance.process(img_rgb)
        else:
            # Fallback to a short-lived local instance if startup initialization failed
            with mp_face_mesh.FaceMesh(
                static_image_mode=False,
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.45,
                min_tracking_confidence=0.45,
            ) as local_mesh:
                results = local_mesh.process(img_rgb)
    except Exception as e:
        logger.exception("FaceMesh processing error: %s", e)
        raise HTTPException(status_code=500, detail="CV processing error")

    if not results or not results.multi_face_landmarks:
        # No face detected; still return structure so frontend can continue
        logger.debug("No face landmarks found; bubblePositions present=%s", bool(req.bubblePositions))
        return FrameResponse(faceDetected=False, confidence=0.0)

    landmarks = results.multi_face_landmarks[0].landmark

    # Face centre (nose tip = landmark 1)
    face_cx = landmarks[1].x * img_w
    face_cy = landmarks[1].y * img_h

    gaze_x_norm_raw, gaze_y_norm_raw = estimate_gaze_normalised(landmarks, img_w, img_h)

    if gaze_x_norm_raw is None:
        return FrameResponse(
            faceDetected=True,
            gazeDirection="unknown",
            attentionTarget="none",
            confidence=0.40,
        )

    # Per-session smoothing
    prune_session_states()
    sid = req.sessionId or "_global"
    sess = session_states.setdefault(sid, {
        "prev_gx": gaze_x_norm_raw,
        "prev_gy": gaze_y_norm_raw,
        "gaze_history": deque(maxlen=GAZE_HISTORY_LEN),
        "last_seen": time.time(),
    })

    prev_gx = sess.get("prev_gx", gaze_x_norm_raw)
    prev_gy = sess.get("prev_gy", gaze_y_norm_raw)

    gx = prev_gx * SMOOTHING_ALPHA + gaze_x_norm_raw * (1.0 - SMOOTHING_ALPHA)
    gy = prev_gy * SMOOTHING_ALPHA + gaze_y_norm_raw * (1.0 - SMOOTHING_ALPHA)

    sess["prev_gx"] = gx
    sess["prev_gy"] = gy
    sess["last_seen"] = time.time()

    # Basic blink detection using iris vertical span relative to eye height
    try:
        def pt(i):
            return np.array([landmarks[i].x * img_w, landmarks[i].y * img_h], dtype=np.float32)

        l_iris = np.stack([pt(i) for i in LEFT_IRIS])
        r_iris = np.stack([pt(i) for i in RIGHT_IRIS])
        l_span = float(l_iris[:, 1].max() - l_iris[:, 1].min())
        r_span = float(r_iris[:, 1].max() - r_iris[:, 1].min())

        l_eye_h = abs(landmarks[L_CORNER_OUTER].y - landmarks[L_CORNER_INNER].y) * img_h
        r_eye_h = abs(landmarks[R_CORNER_OUTER].y - landmarks[R_CORNER_INNER].y) * img_h
        eye_open_ratio = ( (l_span + r_span) / 2.0 ) / max(1.0, ( (l_eye_h + r_eye_h) / 2.0 ))
        blink = eye_open_ratio < 0.12
    except Exception:
        blink = False

    # Compute a dynamic confidence score from several heuristics
    # face size (fraction of image), centrality, recent gaze stability, and head rotation
    try:
        ys = np.array([lm.y for lm in landmarks])
        face_h_frac = float((ys.max() - ys.min()))
    except Exception:
        face_h_frac = 0.25

    centrality = 1.0 - abs((face_cx / img_w) - 0.5) * 2.0
    # estimate rough head rotation influence
    yaw = round((landmarks[1].x - 0.5) * 90, 1)
    pitch = round((landmarks[1].y - 0.5) * 60, 1)
    head_rot_mag = min(1.0, (abs(yaw) + abs(pitch)) / 120.0)

    # gaze stability (variance) over recent history
    gh = list(sess.get("gaze_history", []))
    if gh:
        arr = np.array([[g[1], g[2]] for g in gh])
        var = float(np.mean(np.var(arr, axis=0)))
    else:
        var = 0.0
    var_norm = min(1.0, var / 0.02)

    confidence = max(0.0, min(1.0, 0.35 * centrality + 0.30 * min(1.0, face_h_frac * 2.0) + 0.25 * (1.0 - var_norm) + 0.10 * (1.0 - head_rot_mag)))

    if blink:
        # reject frames where eyes are closed — very low confidence
        confidence = 0.0

    # map smoothed gaze to screen coordinates
    sx, sy = gaze_to_screen(
        gx, gy,
        face_cx, face_cy,
        img_w, img_h,
        req.screenWidth, req.screenHeight,
    )

    direction = classify_direction(gx, gy)
    bubbles = req.bubblePositions or []
    if not bubbles:
        logger.debug("analyze-frame: no bubblePositions sent from frontend; mapping may be inaccurate")
    target = nearest_bubble_target(sx, sy, bubbles)

    # append to session gaze history for stability measures
    sess["gaze_history"].append((time.time(), gx, gy, confidence))

    return FrameResponse(
        faceDetected=True,
        gazeX=round(sx, 1),
        gazeY=round(sy, 1),
        gazeDirection=direction,
        attentionTarget=target,
        confidence=round(float(confidence), 2),
        headPoseYaw=yaw,
        headPosePitch=pitch,
    )


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
