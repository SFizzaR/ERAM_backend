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

    with mp_face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.45,
        min_tracking_confidence=0.45,
    ) as face_mesh:
        results = face_mesh.process(img_rgb)

    if not results.multi_face_landmarks:
        return FrameResponse(faceDetected=False, confidence=0.0)

    landmarks = results.multi_face_landmarks[0].landmark

    # Face centre (nose tip = landmark 1)
    face_cx = landmarks[1].x * img_w
    face_cy = landmarks[1].y * img_h

    gaze_x_norm, gaze_y_norm = estimate_gaze_normalised(landmarks, img_w, img_h)

    if gaze_x_norm is None:
        return FrameResponse(
            faceDetected=True,
            gazeDirection="unknown",
            attentionTarget="none",
            confidence=0.40,
        )

    sx, sy = gaze_to_screen(
        gaze_x_norm, gaze_y_norm,
        face_cx, face_cy,
        img_w, img_h,
        req.screenWidth, req.screenHeight,
    )

    direction = classify_direction(gaze_x_norm, gaze_y_norm)
    target = nearest_bubble_target(sx, sy, req.bubblePositions or [])

    # Rough head pose (degrees) from nose-tip offset
    yaw   = round((landmarks[1].x - 0.5) * 90, 1)
    pitch = round((landmarks[1].y - 0.5) * 60, 1)

    return FrameResponse(
        faceDetected=True,
        gazeX=round(sx, 1),
        gazeY=round(sy, 1),
        gazeDirection=direction,
        attentionTarget=target,
        confidence=0.78,
        headPoseYaw=yaw,
        headPosePitch=pitch,
    )


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
