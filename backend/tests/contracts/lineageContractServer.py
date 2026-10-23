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
    assert source.owner_github_id == '9223372036854775807'
    assert source.is_fork is True
    assert source.fork_parent_github_id == '222'
    assert source.fork_family_github_id == '333'
    assert source.lineage_source == 'github-graphql-repository'
    material = v2._repository_embedding_payload(request)
    payload = build_vector_payload(material, repo_id=str(request.repo_id),
        final_embedding=[1.0] + [0.0] * 383, readme_chunks=0,
        source_hash='a' * 64, config=RepositoryEmbeddingConfig())
    assert payload['repo_id'] == str(request.repo_id)
    assert payload['owner_github_id'] == source.owner_github_id
    assert payload['fork_parent_github_id'] == source.fork_parent_github_id
    assert payload['fork_family_github_id'] == source.fork_family_github_id
    assert payload['is_fork'] is True
    assert datetime.fromisoformat(payload['lineage_observed_at']).microsecond == 1
    return {'schema_version':2,'accepted':True,'status':'applied',
        'job_id':str(request.job_id),'repo_id':str(request.repo_id),'content_version':request.content_version,
        'embedding_version':'contract-embedding-v2','card_summary':{
            'summary':source.description,'highlights':[],'prompt_version':'repo-card-summary-v1',
            'model_version':'repository-description-fallback-v1','format_version':'repo-card-summary-json-v1',
            'source':'description_fallback'}}

v2._embed_repository_job = embed
listener = socket.socket()
listener.bind(('127.0.0.1',0))
listener.listen(128)
print(f'LINEAGE_CONTRACT_PORT={listener.getsockname()[1]}',flush=True)
uvicorn.Server(uvicorn.Config(app,lifespan='off',log_level='error')).run(sockets=[listener])
