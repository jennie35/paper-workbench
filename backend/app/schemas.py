from pydantic import BaseModel, Field


class Login(BaseModel):
    password: str = Field(min_length=1, max_length=500)


class Scope(BaseModel):
    research_question: str = ''
    keywords: list[str] = Field(default_factory=list, max_length=20)
    include: str = ''
    exclude: str = ''
    inferred: bool = True


class ProjectInput(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    goal: str = Field(default='', max_length=10000)


class BatchInput(BaseModel):
    count: int = Field(default=5, ge=1, le=20)


class ProviderInput(BaseModel):
    base_url: str
    api_key: str = ''
    text_model: str = Field(min_length=1, max_length=200)
    vision_model: str = Field(min_length=1, max_length=200)
    openalex_key: str = ''


class Evidence(BaseModel):
    id: str
    claim: str
    observation: str
    source_block_ids: list[str] = Field(min_length=1)
    interpretation: str
    limits: str
    origin: str = Field(default='analyst_inference', pattern='^(paper_fact|author_interpretation|analyst_inference|hypothesis)$')


class Action(BaseModel):
    id: str
    title: str
    evidence_ids: list[str] = Field(min_length=1)
    gap: str
    hypothesis: str
    method: str
    controls: str
    supporting: str
    weakening: str
    resources: str
    priority: str = Field(pattern='^P[0-3]$')
    deliverable: str
    sample_size_basis: str


class Visual(BaseModel):
    page: int = Field(ge=1)
    label: str
    explanation: str
    limitations: str
    kind: str = Field(pattern='^(figure|table|equation)$')


class Analysis(BaseModel):
    summary: str
    scientific_question: str
    author_conclusions: str
    analyst_inference: str
    variables: str
    samples: str
    equipment: str
    parameters: str
    controls: str
    repeats: str
    statistics: str
    flow_steps: list[str] = Field(min_length=2, max_length=8)
    evidence: list[Evidence] = Field(min_length=1)
    reading_list: list[str] = Field(min_length=1)
    future_insights: str
    transfer_conditions: str
    reproduction_checklist: list[str]
    actions: list[Action] = Field(default_factory=list)
    action_status: str = ''
    roadmap: str
    sources: list[str]
    required_visual_pages: list[int]
    visuals: list[Visual] = Field(default_factory=list)
    unread: list[str] = Field(default_factory=list)
