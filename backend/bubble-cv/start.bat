@echo off
echo === Bubble Game CV Service ===
echo Installing dependencies...
pip install -r requirements.txt

echo.
echo Starting server on http://localhost:8001
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
pause
