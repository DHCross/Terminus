import base64
import vertexai
from vertexai.generative_models import GenerativeModel, Part
import sys

try:
    vertexai.init(project="indigo-lambda-502616-s2", location="us-central1")
    model = GenerativeModel(model_name="gemini-1.5-pro-002")

    img_path = "/Users/dancross/.gemini/antigravity-ide/brain/ffee74bb-a112-41a3-ad3a-a0a51eac5fb4/.user_uploaded/media_1786992772659.png"
    with open(img_path, "rb") as f:
        img_data = f.read()
        
    image_part = Part.from_data(data=img_data, mime_type="image/png")
    response = model.generate_content([image_part, "Describe exactly what is wrong with the UI layout in this image. Specifically, look at the chat input box (where you type messages), the left and right sidebars, the chat history, and the new status indicator (pulsing dot / progress bar). Describe their positioning and any overlaps or spacing issues."])
    print(response.text)
except Exception as e:
    print(f"Error: {e}")
