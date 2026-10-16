def metadata(title='Test paper', doi='10.1234/example'):
    return {'title': title, 'doi': doi, 'authors': ['A Researcher'], 'year': 2026, 'publication_date': '2026-01-01', 'publication_status': 'published', 'journal': 'Synthetic test journal', 'url': 'https://example.com/paper', 'pdf_urls': [], 'versions': [doi], 'source': 'test'}


def analysis():
    return {
        'summary':'Synthetic fixture, not real research.',
        'scientific_question':'How can a pipeline preserve evidence?',
        'author_conclusions':'Fixture statements only.',
        'analyst_inference':'No actual scientific inference.',
        'variables':'Not reported', 'samples':'Not reported', 'equipment':'Not reported',
        'parameters':'Not reported', 'controls':'Not reported', 'repeats':'Not reported',
        'statistics':'Not reported', 'flow_steps':['Define question','Check evidence'],
        'evidence':[{'id':'E01','claim':'Fixture statement','observation':'Fixture text observed','source_block_ids':['P0001-B0001'],'interpretation':'Test only','limits':'Synthetic'}],
        'reading_list':['Methods: verify independent units.'], 'future_insights':'Acquire reliable evidence first.',
        'transfer_conditions':'Adapt to actual project.', 'reproduction_checklist':['Acquire original data'],
        'actions':[{'id':'A01','title':'Pilot test','evidence_ids':['E01'],'gap':'No real data','hypothesis':'A hypothesis to be specified','method':'Collect independent data','controls':'Use matched conditions','supporting':'Stable evidence','weakening':'No consistent effect','resources':'Appropriate instruments','priority':'P0','deliverable':'Pilot protocol','sample_size_basis':'Determine from pilot, not invented'}],
        'roadmap':'Acquire evidence, then pilot.', 'sources':['Synthetic fixture'], 'required_visual_pages':[], 'visuals':[], 'unread':[]
    }


def make_pdf(path):
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    w=PdfWriter();p=w.add_blank_page(600,400)
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    p[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):w._add_object(font)})})
    stream=DecodedStreamObject();stream.set_data(b'BT /F1 12 Tf 30 350 Td (Synthetic test paper. A Researcher. This is a generated fixture for software tests only. It contains no scientific results. Figure 1 is a test of evidence display and source identity handling.) Tj ET')
    p[NameObject('/Contents')]=w._add_object(stream);w.write(path)
