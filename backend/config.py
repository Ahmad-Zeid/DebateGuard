import os
from dotenv import load_dotenv

# Load environment variables from a .env file if present
load_dotenv()

# Define and export environment variables here
ENVIRONMENT = os.getenv("ENVIRONMENT", "DEV") 

if ENVIRONMENT not in ["DEV", "PROD"]:
    ENVIRONMENT = "DEV"  # Default to DEV if an invalid value is provided

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")

if ENVIRONMENT == "PROD" and not FRONTEND_URL:
    raise ValueError("CRITICAL: FRONTEND_URL is missing in PROD environment.")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not GEMINI_API_KEY:
    raise ValueError("CRITICAL: GEMINI_API_KEY is missing in PROD environment.")

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./dev_debateguard.db") if ENVIRONMENT == "DEV" else os.getenv("DATABASE_URL")

if ENVIRONMENT == "PROD" and not DATABASE_URL:
    raise ValueError("CRITICAL: DATABASE_URL is missing in PROD environment.")

MODEL = os.getenv("MODEL", "gemini-2.5-flash-native-audio-preview-12-2025")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

SECRET_KEY = os.getenv("SECRET_KEY", "super-secret-key-for-dev")
ALGORITHM = os.getenv("ALGORITHM", "HS256")
