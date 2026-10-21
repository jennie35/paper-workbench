from typing import Literal

from pydantic import BaseModel, Field, model_validator


class Login(BaseModel):
    password: str = Field(min_length=1, max_length=500)


class Scope(BaseModel):
    research_question: str = ''
    keywords: list[str] = Field(default_factory=list, max_length=20)
    include: str = ''
    exclude: str = ''
    inferred: bool = True
    core_question: str = ''
    research_stage: str = '探索'
    research_object: str = ''
    application_context: str = ''
    existing_methods: str = ''
    known_resources: str = ''
    constraints: str = ''
    reference_materials: str = ''
    version_differences: str = ''
    keywords_zh: list[str] = Field(default_factory=list, max_length=30)
    keywords_en: list[str] = Field(default_factory=list, max_length=30)
    default_count: int = Field(default=5, ge=1, le=20)
    output_language: str = Field(default='中文', max_length=100)
    run_mode: Literal['manual', 'existing-task'] = 'manual'
    storage_root: str = ''

    @model_validator(mode='after')
    def question_alias(self):
        self.core_question = self.core_question or self.research_question
        self.research_question = self.core_question
        self.keywords = list(dict.fromkeys([*self.keywords, *self.keywords_zh, *self.keywords_en]))[:20]
        return self


class ProjectInput(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    goal: str = Field(default='', max_length=10000)
    scope: Scope | None = None


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
    question: str = ''
    experimental_unit: str = '未报告；执行前须明确独立实验单位'
    data: str = '待明确实际可用数据'
    confounds: str = '待识别并控制'
    criteria_basis: str = '缺少依据的阈值由先导实验确定'
    prerequisites: str = '待确认资源和前置条件'
    stopping_criteria: str = '前提证据不成立或资源不可用时暂缓并修订方案'
    status: Literal['pending'] = 'pending'


class ReadingScope(BaseModel):
    acquired: list[str] = Field(default_factory=list)
    verified: list[str] = Field(default_factory=list)
    unverified: list[str] = Field(default_factory=list)


class Storyline(BaseModel):
    author_question: str = '未报告'
    reconstructed_question: str = '未核验'
    gap: str = '未核验'
    hypothesis: str = '未报告'
    reasoning: str = '未核验'


class StudyDesign(BaseModel):
    type: Literal['experimental', 'method', 'theory', 'review', 'dataset', 'system', 'mixed', 'unknown'] = 'unknown'
    fields: dict[str, str] = Field(default_factory=dict)


class DesignDecision(BaseModel):
    decision: str
    problem: str
    rationale: str
    rationale_origin: Literal['paper_fact', 'author_interpretation', 'analyst_inference', 'unreported', 'unknown'] = 'analyst_inference'
    cost: str
    alternative: str
    possible_effect: str = ''
    source_block_ids: list[str] = Field(default_factory=list)


class EvidenceReview(BaseModel):
    kind: str
    locator: str
    claim: str
    comparison: str
    axes_units: str
    statistical_unit: str
    uncertainty: str
    consistency: str
    purpose: str = ''
    symbols: str = ''
    measurand: str = ''
    applicability: str = ''
    panels: str = ''
    error_bars: str = ''
    effect_size: str = ''
    verification_status: str = 'unverified'
    source_block_ids: list[str] = Field(default_factory=list)


class ConclusionLayers(BaseModel):
    author_results: str = '未核验'
    author_interpretation: str = '未报告'
    analyst_inference: str = '未核验'
    unverified_hypotheses: str = '未报告'


class ReadingPriority(BaseModel):
    kind: str
    locator: str
    reason: str
    decision_impact: str
    source_block_ids: list[str] = Field(default_factory=list)


class TransferInsights(BaseModel):
    direct: str = '尚不能确认可直接迁移的内容'
    adapt: str = '需先确认对象、协议、指标和资源条件'
    avoid: str = '未核验结论不直接迁移'
    judgement_change: str = '证据不足时保留原判断'


class Pitfall(BaseModel):
    kind: str
    assessment: str
    source_block_ids: list[str] = Field(default_factory=list)


class ResearchLogic(BaseModel):
    reading_scope: ReadingScope = Field(default_factory=ReadingScope)
    storyline: Storyline = Field(default_factory=Storyline)
    study_design: StudyDesign = Field(default_factory=StudyDesign)
    design_decisions: list[DesignDecision] = Field(default_factory=list)
    evidence_review: list[EvidenceReview] = Field(default_factory=list)
    conclusion_layers: ConclusionLayers = Field(default_factory=ConclusionLayers)
    reading_priorities: list[ReadingPriority] = Field(default_factory=list)
    transfer_insights: TransferInsights = Field(default_factory=TransferInsights)
    pitfalls: list[Pitfall] = Field(default_factory=list)


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
    research_logic: ResearchLogic | None = None
