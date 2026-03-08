import easyocr
from flask import Flask, request, jsonify
from tensorflow.keras.models import load_model
import numpy as np
import os
import cv2
from pmdc import extract_name_and_registration

# =======================================
# Initialize Flask app
# =======================================
app = Flask(__name__)

# =======================================
# Load Models
# =======================================
base_path = os.path.dirname(os.path.abspath(__file__))

# Update these paths as per your actual folders
model_toddler = load_model(os.path.join(base_path, "QCHAT10", "toddler_model.keras"))
model_child = load_model(os.path.join(base_path, "AQ10_Child", "child_model.keras"))
model_adolescent = load_model(os.path.join(base_path, "AQ10_Adolescent", "adolescent_model.keras"))

# =======================================
# Label Classes (no pickle needed)
# =======================================
label_classes = ['NO', 'YES']

# =======================================
# Initialize EasyOCR Reader
# =======================================
reader = easyocr.Reader(['en'])

# =======================================
# Prediction Route
# =======================================
@app.route('/predict', methods=['POST'])
def predict():
    try:
        data = request.get_json()

        # Validate age
        age = float(data.get('Age', 0))
        if age > 15:
            return jsonify({'error': 'Screening available only for under 16'}), 400
        elif age < 1:
            return jsonify({'error': 'Screening available only for children above 1'}), 400

        # Extract features A1–A10
        features = [data.get(f'A{i}') for i in range(1, 11)]
        if None in features:
            return jsonify({'error': 'Missing one or more question values (A1–A10)'}), 400

        # Add age as the last feature
        features.append(age)
        X_input = np.array(features).reshape(1, -1)

        # Select model based on age
        if age < 4:
            model = model_toddler
            model_name = "Toddler (QCHAT-10)"
        elif age < 12:
            model = model_child
            model_name = "Child (AQ-10 Child)"
        else:
            model = model_adolescent
            model_name = "Adolescent (AQ-10 Adolescent)"

        # Predict
                # Select model based on age
        if age < 4:
            model = model_toddler
            model_name = "Toddler (QCHAT-10)"
            threshold = 0.5  # keep standard for toddlers
        elif age < 12:
            model = model_child
            model_name = "Child (AQ-10 Child)"
            threshold = 0.5  # lower threshold for fewer false negatives
        else:
            model = model_adolescent
            model_name = "Adolescent (AQ-10 Adolescent)"
            threshold = 0.5  # lower threshold for fewer false negatives

        # Predict
        prediction = model.predict(X_input)
        pred_label = 1 if prediction[0][0] >= threshold else 0
        result_text = "YES" if pred_label == 1 else "NO"


        # Return response
        return jsonify({
            'model_used': model_name,
            'age': age,
            'prediction_score': float(prediction[0][0]),
            'result': result_text
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


# =======================================
# Health Check Route
# =======================================
@app.route('/')
def index():
    return jsonify({'message': 'Autism Screening API is running 🚀'})
# =======================================
# PMDC Verification Route
# =======================================
@app.route("/extract", methods=["POST"])
def extract():

    if "image" not in request.files:
        return jsonify({"error": "No image uploaded"}), 400

    file = request.files["image"]

    # Convert file to numpy array for OpenCV
    file_bytes = np.frombuffer(file.read(), np.uint8)
    image = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)

    if image is None:
        return jsonify({"error": "Invalid image file"}), 400

    # OCR
    ocr_results = reader.readtext(image)

    # Extract fields
    registration_number, name, fathername = extract_name_and_registration(ocr_results)

    return jsonify({
        "registration_number": registration_number,
        "name": name,
        "father_name": fathername
    })


# =======================================
# Run Flask App
# =======================================
if __name__ == '__main__':
    app.run(debug=True)
