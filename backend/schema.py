import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import List, Optional


from sqlmodel import SQLModel, Field, Relationship, Column, JSON

class DebateMode(str, Enum):
    FREE_CALL = "DEBATE"
    COACH = "COACH"

class RoleEnum(str, Enum):
    user = "user"
    agent = "agent"

class ReportStatus(str, Enum):
    idle = "idle"
    generating = "generating"
    done = "done"
    failed = "failed"

class User(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str
    email: str = Field(unique=True, index=True)
    password_hash: str
    monthly_debate_count: int = Field(default=0)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    debates: List["Debate"] = Relationship(
        back_populates="user",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )

class Debate(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: uuid.UUID = Field(foreign_key="user.id", index=True)
    title: str
    description: str
    mode: DebateMode
    report_status: ReportStatus = Field(default=ReportStatus.idle)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    user: Optional[User] = Relationship(back_populates="debates")
    report: Optional["Report"] = Relationship(
        back_populates="debate",
        sa_relationship_kwargs={"uselist": False, "cascade": "all, delete-orphan"}
    )
    telemetry: List["Telemetry"] = Relationship(
        back_populates="debate",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    transcript_lines: List["TranscriptLine"] = Relationship(
        back_populates="debate",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "order_by": "TranscriptLine.timestamp"}
    )

class Report(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    debate_id: uuid.UUID = Field(foreign_key="debate.id", unique=True, index=True)

    telemetry_stats: List[float] = Field(
        default_factory=lambda: [0.0] * 7, 
        min_length=7,
        max_length=7,
        sa_column=Column(JSON)
    )
    report: str

    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    debate: Optional[Debate] = Relationship(back_populates="report")

class Telemetry(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    debate_id: uuid.UUID = Field(foreign_key="debate.id", index=True)
    
    secondStart: int
    secondEnd: int

    gaze: bool = Field(default=False)
    posture: bool = Field(default=False)
    shielding: bool = Field(default=False)
    yaw: bool = Field(default=False)
    soothing: bool = Field(default=False)
    swaying: bool = Field(default=False)
    tilt: bool = Field(default=False)

    debate: Optional[Debate] = Relationship(back_populates="telemetry")

class TranscriptLine(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    debate_id: uuid.UUID = Field(foreign_key="debate.id", index=True)
    
    role: RoleEnum
    text: str
    timestamp: int
    is_final: bool = Field(default=True)
    
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    debate: Optional["Debate"] = Relationship(back_populates="transcript_lines")