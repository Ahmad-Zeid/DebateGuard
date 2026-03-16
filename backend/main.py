import asyncio
import base64
import json
import logging
import uuid
from datetime import datetime, timezone
from contextlib import asynccontextmanager

import jwt
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, status, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select
from pydantic import BaseModel
from google import genai

from config import HOST, PORT, GEMINI_API_KEY, MODEL, FRONTEND_URL, SECRET_KEY, ALGORITHM
from gemini_live import GeminiLive
from db import create_db_and_tables, get_session
from schema import User, Debate, DebateMode, Telemetry, TranscriptLine, Report, RoleEnum, ReportStatus
from auth import router as auth_router, get_current_user

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    yield

# Initialize FastAPI
app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)

class DebateCreate(BaseModel):
    title: str
    description: str
    mode: DebateMode

@app.post("/debates/")
def create_debate(debate: DebateCreate, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    now = datetime.now(timezone.utc)
    start_of_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    
    statement = select(Debate).where(Debate.user_id == user.id, Debate.created_at >= start_of_month)
    debates_this_month = session.exec(statement).all()
    if len(debates_this_month) >= 5:
        raise HTTPException(status_code=429, detail="Maximum of 5 debates per month reached.")
    
    new_debate = Debate(
        user_id=user.id,
        title=debate.title,
        description=debate.description,
        mode=debate.mode
    )
    session.add(new_debate)
    session.commit()
    session.refresh(new_debate)
    
    return new_debate

@app.get("/debates/")
def list_debates(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    statement = select(Debate).where(Debate.user_id == user.id).order_by(Debate.created_at.desc())
    debates = session.exec(statement).all()
    return debates

@app.websocket("/ws/debate/{debate_id}")
async def websocket_endpoint(websocket: WebSocket, debate_id: uuid.UUID, token: str = Query(...), session: Session = Depends(get_session)):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        user = session.get(User, user_id)
        if not user:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
    except Exception:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    debate = session.get(Debate, debate_id)
    if not debate or debate.user_id != user.id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    logger.info("WebSocket connection accepted")

    audio_input_queue = asyncio.Queue()
    video_input_queue = asyncio.Queue()
    text_input_queue = asyncio.Queue()

    async def audio_output_callback(data):
        await websocket.send_bytes(data)

    async def audio_interrupt_callback():
        pass

    gemini_client = GeminiLive(
        api_key=GEMINI_API_KEY, 
        model=MODEL, 
        input_sample_rate=16000,
        type=debate.mode.value,
        title=debate.title,
        description=debate.description,
    )

    async def receive_from_client():
        try:
            while True:
                message = await websocket.receive()

                if message.get("bytes"):
                    # Raw PCM chunks
                    await audio_input_queue.put(message["bytes"])
                elif message.get("text"):
                    text = message["text"]
                    try:
                        payload = json.loads(text)
                        msg_type = payload.get("type")
                        if msg_type == "telemetry":
                            metrics = payload.get("metrics", [False]*7)
                            start_sec = payload.get("secondStart", 0)
                            end_sec = payload.get("secondEnd", 0)
                            
                            t = Telemetry(
                                debate_id=debate.id,
                                secondStart=start_sec,
                                secondEnd=end_sec,
                                gaze=metrics[0], posture=metrics[1], shielding=metrics[2],
                                yaw=metrics[3], soothing=metrics[4], swaying=metrics[5], tilt=metrics[6]
                            )
                            session.add(t)
                            session.commit()
                        elif msg_type == "nudge":
                            nudge_text = payload.get("text", "")
                            await text_input_queue.put(f"[COACHING NUDGE: {nudge_text}]")
                        elif msg_type == "image":
                            logger.info(f"Received image chunk from client: {len(payload['data'])} base64 chars")
                            image_data = base64.b64decode(payload["data"])
                            await video_input_queue.put(image_data)
                        else:
                            await text_input_queue.put(text)
                    except json.JSONDecodeError:
                        await text_input_queue.put(text)
        except WebSocketDisconnect:
            logger.info("WebSocket disconnected")
        except Exception as e:
            logger.error(f"Error receiving from client: {e}")

    receive_task = asyncio.create_task(receive_from_client())

    async def run_session():
        async for event in gemini_client.start_session(
            audio_input_queue=audio_input_queue,
            video_input_queue=video_input_queue,
            text_input_queue=text_input_queue,
            audio_output_callback=audio_output_callback,
            audio_interrupt_callback=audio_interrupt_callback,
        ):
            if event:
                if isinstance(event, dict):
                    # Handle transcript persistence
                    if event.get("type") in ["user", "gemini"]:
                        role = "user" if event["type"] == "user" else "agent"
                        is_final = event.get("is_final", True)
                        
                        if is_final:
                            # Use current timestamp
                            timestamp = int(datetime.now(timezone.utc).timestamp())
                            tl = TranscriptLine(
                                debate_id=debate.id,
                                role=role,
                                text=event.get("text", ""),
                                timestamp=timestamp,
                                is_final=is_final
                            )
                            session.add(tl)
                            session.commit()

                        # Forward to frontend exactly
                        await websocket.send_json({
                            "type": "transcript",
                            "role": role,
                            "text": event.get("text", ""),
                            "is_final": is_final
                        })
                    else:
                        await websocket.send_json(event)

    try:
        await run_session()
    except Exception as e:
        logger.error(f"Error in Gemini session: {e}")
    finally:
        receive_task.cancel()
        try:
            await websocket.close()
        except:
            pass

@app.post("/debates/{debate_id}/report")
def generate_report(debate_id: uuid.UUID, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    debate = session.get(Debate, debate_id)
    if not debate or debate.user_id != user.id:
        raise HTTPException(status_code=404, detail="Debate not found")

    # Rate-limit: prevent duplicate generation
    if debate.report_status == ReportStatus.generating:
        raise HTTPException(status_code=409, detail="Report is already being generated")
    if debate.report_status == ReportStatus.done:
        return {"message": "Report already exists"}

    # Mark as generating
    debate.report_status = ReportStatus.generating
    session.commit()

    try:
        telemetry_records = session.exec(select(Telemetry).where(Telemetry.debate_id == debate_id)).all()
        transcript_records = session.exec(select(TranscriptLine).where(TranscriptLine.debate_id == debate_id).order_by(TranscriptLine.timestamp)).all()

        # Calculate stats
        total = len(telemetry_records)
        stats = [0.0] * 7
        if total > 0:
            counts = [0] * 7
            for t in telemetry_records:
                if t.gaze: counts[0] += 1
                if t.posture: counts[1] += 1
                if t.shielding: counts[2] += 1
                if t.yaw: counts[3] += 1
                if t.soothing: counts[4] += 1
                if t.swaying: counts[5] += 1
                if t.tilt: counts[6] += 1
            
            # (1 - mean of bools) * 100
            stats = [(1.0 - (c / total)) * 100.0 for c in counts]

        # Generate Report via Gemini
        transcript_text = "\n".join([f"{t.role}: {t.text}" for t in transcript_records])
        prompt = f"""Act as a Senior Debate Analyst and Body Language Expert. Your task is to generate a comprehensive, high-stakes Performance Audit for a candidate based on a recent debate session. 

        ### **Input Data:**
        **Transcript:**
        {transcript_text}

        **Telemetry Stats (Average Success Rates):**
        {telemetry_records} 
        (Note: Stats are success percentages. 100% means perfect behavior, 0% means constant failure.)

        ---

        ### **Markdown Report Requirements:**

        #### **1. Overview**
        - Provide a high-level executive summary of the user's performance.
        - Evaluate "Logical Dominance": Did the user control the flow or react to the agent?
        - Presence Assessment: Combine the telemetry data with the transcript to describe the user's "Stage Presence" (e.g., "High logical clarity but undermined by anxious physical cues").

        #### **2. Turn-by-Turn Analysis**
        - Provide a chronological breakdown of the most critical exchanges.
        - **Rhetorical Hits:** Identify where the user used strong evidence or effective rebuttals.
        - **Logical Fallacies:** Explicitly flag any fallacies committed (e.g., Ad Hominem, Strawman, Red Herring).
        - **The Debunker Log:** Specifically mention if the user was called out by the Search Tool for "fake stats" and how they handled the pivot.
        - **Behavioral Correlation:** Note if specific high-stress arguments coincided with telemetry failures (e.g., "During the tax policy exchange, the user's Gaze Success dropped to 20%").

        #### **3. Final Advice**
        - **Tactical Fixes:** 3 specific ways to improve logical structuring.
        - **Physical Fixes:** 2 specific body language adjustments based on the lowest telemetry scores.
        - **Closing Verdict:** A one-sentence professional assessment of whether the user "won" or "lost" the logical battle.

        ---

        ### **Stylistic Constraints:**
        - **Tone:** Extremely formal, objective, and sharp. 
        - **Formatting:** Use Markdown headers (##, ###), bold text for emphasis, and bullet points for readability.
        - **No Filler:** Do not use introductory phrases like "Here is the report." Start immediately with the title: # DEBATE PERFORMANCE AUDIT.
        """
        
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(
            model="gemini-3-flash-preview",
            contents=prompt
        )
        markdown_report = response.text

        # Save to Report
        report_record = session.exec(select(Report).where(Report.debate_id == debate_id)).first()
        if not report_record:
            report_record = Report(debate_id=debate_id, telemetry_stats=stats, report=markdown_report)
            session.add(report_record)
        else:
            report_record.telemetry_stats = stats
            report_record.report = markdown_report

        debate.report_status = ReportStatus.done
        session.commit()
        return {"message": "Report generated successfully"}

    except Exception as e:
        debate.report_status = ReportStatus.failed
        session.commit()
        logger.error(f"Report generation failed: {e}")
        raise HTTPException(status_code=500, detail="Report generation failed")

@app.get("/debates/{debate_id}/report")
def get_report(debate_id: uuid.UUID, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    debate = session.get(Debate, debate_id)
    if not debate or debate.user_id != user.id:
        raise HTTPException(status_code=404, detail="Debate not found")

    report_record = session.exec(select(Report).where(Report.debate_id == debate_id)).first()
    if not report_record:
        raise HTTPException(status_code=404, detail="Report not generated yet")
    
    return {
        "stats": report_record.telemetry_stats,
        "report": report_record.report
    }

if __name__ == "__main__":
    import uvicorn
    port = int(PORT)
    uvicorn.run("main:app", host=HOST, port=port, reload=True)
