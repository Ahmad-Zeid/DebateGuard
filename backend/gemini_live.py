import asyncio
import inspect
import logging
import time
import socket

# Force IPv4 to prevent IPv6 timeout hangs in websockets ("timed out during opening handshake")
orig_getaddrinfo = socket.getaddrinfo

def patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)

socket.getaddrinfo = patched_getaddrinfo

logger = logging.getLogger(__name__)
from google import genai
from google.genai import types

class GeminiLive:
    """
    Handles the interaction with the Gemini Live API.
    """
    def __init__(self, api_key, model, type, input_sample_rate, tools=None, tool_mapping=None):
        """
        Initializes the GeminiLive client.

        Args:
            api_key (str): The Gemini API Key.
            model (str): The model name to use.
            type (str): The type of the conversation.
            input_sample_rate (int): The sample rate for audio input.
            tools (list, optional): List of tools to enable. Defaults to None.
            tool_mapping (dict, optional): Mapping of tool names to functions. Defaults to None.
        """
        self.api_key = api_key
        self.model = model
        self.type = type
        self.input_sample_rate = input_sample_rate
        self.client = genai.Client(api_key=api_key, http_options={"api_version": "v1alpha"})
        
        self.tools = tools or [{"google_search": {}}]
        self.tool_mapping = tool_mapping or {}
        self.user_speech_duration = 0.0
        
        if self.type not in ["DEBATE", "COACH"]:
            self.type = "COACH"
        
        self.is_agent_talking = False

        if self.type == "DEBATE":
            self.prompt = (
                "You are a fierce, adversarial debate opponent. Challenge every argument the user makes. "
                "Use logic, evidence, and rhetorical skill to counter their points. Never concede easily. "
                "Be respectful but relentless. Push the user to defend their position rigorously. "
                "You can see the user via their camera feed — use visual cues to inform your responses."
            )
        else:
            self.prompt = (
                "You are an expert debate coach. Help the user improve their argumentation and delivery. "
                "Provide constructive feedback on their reasoning, rhetoric, and presentation. "
                "When you receive coaching nudges about body language issues, naturally weave that feedback "
                "into the conversation. Be supportive but honest about areas for improvement. "
                "You can see the user via their camera feed — comment on their posture and presence."
            )

    async def start_session(self, audio_input_queue, video_input_queue, text_input_queue, audio_output_callback, audio_interrupt_callback=None):
        config = types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Puck"
                    )
                )
            ),
            system_instruction=types.Content(parts=[types.Part(text=self.prompt)]),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            proactivity=types.ProactivityConfig(proactive_audio=True),
            enable_affective_dialog=True,
            tools=self.tools,
        )
        
        async with self.client.aio.live.connect(model=self.model, config=config) as session:
            
            async def send_audio():
                try:
                    while True:
                        chunk = await audio_input_queue.get()
                        await session.send_realtime_input(
                            audio=types.Blob(data=chunk, mime_type=f"audio/pcm;rate={self.input_sample_rate}")
                        )
                        
                        # Soft interruption logic
                        if self.is_agent_talking:
                            # Estimate duration based on 16-bit PCM mono
                            chunk_duration = len(chunk) / (self.input_sample_rate * 2)
                            self.user_speech_duration += chunk_duration
                            
                            if self.user_speech_duration > 2:
                                logger.info("User speech > 2s during agent turn. Sending system nudge.")
                                await text_input_queue.put("Moderator Note: User is trying to interrupt. Do not stop your point, but acknowledge the interjection at the end of this sentence.")
                                self.user_speech_duration = 0 # Reset nudge
                        else:
                            self.user_speech_duration = 0.0
                            
                except asyncio.CancelledError:
                    pass

            async def send_video():
                try:
                    while True:
                        chunk = await video_input_queue.get()
                        logger.info(f"Sending video frame to Gemini: {len(chunk)} bytes")
                        await session.send_realtime_input(
                            video=types.Blob(data=chunk, mime_type="image/jpeg")
                        )
                except asyncio.CancelledError:
                    pass

            async def send_text():
                try:
                    while True:
                        text = await text_input_queue.get()
                        logger.info(f"Sending text to Gemini: {text}")
                        await session.send_realtime_input(text=text)
                except asyncio.CancelledError:
                    pass

            event_queue = asyncio.Queue()

            async def receive_loop():
                try:
                    while True:
                        async for response in session.receive():
                            logger.debug(f"Received response from Gemini: {response}")
                            server_content = response.server_content
                            tool_call = response.tool_call
                            
                            if server_content:
                                if server_content.model_turn:
                                    self.is_agent_talking = True
                                    for part in server_content.model_turn.parts:
                                        if part.inline_data:
                                            if inspect.iscoroutinefunction(audio_output_callback):
                                                await audio_output_callback(part.inline_data.data)
                                            else:
                                                audio_output_callback(part.inline_data.data)
                                
                                if server_content.input_transcription and server_content.input_transcription.text:
                                    await event_queue.put({"type": "user", "text": server_content.input_transcription.text})
                                
                                if server_content.output_transcription and server_content.output_transcription.text:
                                    await event_queue.put({"type": "gemini", "text": server_content.output_transcription.text})
                                
                                if server_content.turn_complete:
                                    self.is_agent_talking = False
                                    self.user_speech_duration = 0.0
                                    await event_queue.put({"type": "turn_complete"})
                                
                                if server_content.interrupted:
                                    self.is_agent_talking = False
                                    self.user_speech_duration = 0.0
                                    
                                    # Recovery prompt text nudge
                                    logger.info("Agent was interrupted. Forcing recovery...")
                                    await text_input_queue.put("You were interrupted. Briefly acknowledge the point and finish your previous argument.")
                                    
                                    if audio_interrupt_callback:
                                        if inspect.iscoroutinefunction(audio_interrupt_callback):
                                            await audio_interrupt_callback()
                                        else:
                                            audio_interrupt_callback()
                                    await event_queue.put({"type": "interrupted"})

                            if tool_call:
                                function_responses = []
                                for fc in tool_call.function_calls:
                                    func_name = fc.name
                                    args = fc.args or {}
                                    
                                    if func_name in self.tool_mapping:
                                        try:
                                            tool_func = self.tool_mapping[func_name]
                                            if inspect.iscoroutinefunction(tool_func):
                                                result = await tool_func(**args)
                                            else:
                                                loop = asyncio.get_running_loop()
                                                result = await loop.run_in_executor(None, lambda: tool_func(**args))
                                        except Exception as e:
                                            result = f"Error: {e}"
                                        
                                        function_responses.append(types.FunctionResponse(
                                            name=func_name,
                                            id=fc.id,
                                            response={"result": result}
                                        ))
                                        await event_queue.put({"type": "tool_call", "name": func_name, "args": args, "result": result})
                                
                                await session.send_tool_response(function_responses=function_responses)

                except Exception as e:
                    await event_queue.put({"type": "error", "error": str(e)})
                finally:
                    await event_queue.put(None)

            send_audio_task = asyncio.create_task(send_audio())
            send_video_task = asyncio.create_task(send_video())
            send_text_task = asyncio.create_task(send_text())
            receive_task = asyncio.create_task(receive_loop())

            try:
                while True:
                    event = await event_queue.get()
                    if event is None:
                        break
                    if isinstance(event, dict) and event.get("type") == "error":
                        # Just yield the error event, don't raise to keep the stream alive if possible or let caller handle
                        yield event
                        break 
                    yield event
            finally:
                send_audio_task.cancel()
                send_video_task.cancel()
                send_text_task.cancel()
                receive_task.cancel()
