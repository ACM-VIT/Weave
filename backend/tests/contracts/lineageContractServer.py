"""Actual registered HTTP/auth/schema/admission and pure vector-payload projection.

External encoder/storage are replaced; this does not prove Qdrant persistence or
model quality. Run only against the exact pinned provider checkout.
"""
import os
import socket
from datetime import datetime
os.environ['INTERNAL_API_SECRET'] = 'local-lineage-contract-secret'
os.environ['APP_ENV'] = 'development'
import uvicorn
from api import v2
from api.main import app
from embedding.repository_embedding import build_vector_payload, RepositoryEmbeddingConfig


def embed(request, deadline=None):
    source = request.repository
    language_fixture = source.full_name.startswith('language-pair-fixture-')
    if not language_fixture:
        assert source.owner_github_id == '9223372036854775807'
        assert source.lineage_source == 'github-graphql-repository'
    material = v2._repository_embedding_payload(request)
    payload = build_vector_payload(material, repo_id=str(request.repo_id),
        final_embedding=[1.0] + [0.0] * 383, readme_chunks=0,
        source_hash='a' * 64, config=RepositoryEmbeddingConfig())
    assert payload['repo_id'] == str(request.repo_id)
    assert payload['owner_github_id'] == source.owner_github_id
    if language_fixture:
        variant = 'languages'
        expected = [{'name': 'Python', 'color': '#3572A5', 'size': 300, 'percentage': 30},
                    {'name': 'Rust', 'color': None, 'size': 200, 'percentage': 20}]
        assert [item.model_dump() for item in source.language_breakdown] == expected
        assert source.languages == ['Python', 'Rust'] and source.primary_language == 'Rust'
        assert material['language_breakdown'] == payload['language_breakdown'] == expected
        assert material['language_total_size'] == payload['language_total_size'] == 1000
        assert material['language_breakdown_complete'] is payload['language_breakdown_complete'] is False
    elif source.is_fork is None:
        variant = 'unknown'
        assert source.fork_parent_github_id is None and source.fork_family_github_id is None
        assert all(key not in payload for key in ('is_fork', 'fork_parent_github_id', 'fork_family_github_id'))
    elif source.is_fork is False:
        variant = 'nonfork'
        assert source.fork_parent_github_id is None and source.fork_family_github_id == source.github_id == '123'
        assert payload['is_fork'] is False and 'fork_parent_github_id' not in payload
        assert payload['fork_family_github_id'] == source.github_id
    else:
        variant = 'fork'
        assert source.fork_parent_github_id == payload['fork_parent_github_id'] == '222'
        assert source.fork_family_github_id == payload['fork_family_github_id'] == '333'
        assert payload['is_fork'] is True
    if not language_fixture:
        assert payload['lineage_source'] == source.lineage_source
        assert datetime.fromisoformat(payload['lineage_observed_at']).microsecond == 1
        assert all(key not in payload for key in ('language_breakdown', 'language_total_size', 'language_breakdown_complete'))
    return {'schema_version':2,'accepted':True,'status':'applied',
        'job_id':str(request.job_id),'repo_id':str(request.repo_id),'content_version':request.content_version,
        'embedding_version':f'contract-embedding-v2-{variant}','card_summary':{
            'summary':source.description,'highlights':[],'prompt_version':'repo-card-summary-v1',
            'model_version':'repository-description-fallback-v1','format_version':'repo-card-summary-json-v1',
            'source':'description_fallback'}}

v2._embed_repository_job = embed
listener = socket.socket()
listener.bind(('127.0.0.1',0))
listener.listen(128)
print(f'LINEAGE_CONTRACT_PORT={listener.getsockname()[1]}',flush=True)
uvicorn.Server(uvicorn.Config(app,lifespan='off',log_level='error')).run(sockets=[listener])
