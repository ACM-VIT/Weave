"""Loopback contract fixture; real routes/auth/admission, deterministic model boundary.

Run only from the pinned provider checkout with its interpreter. This is not
representative ranking or production-storage acceptance.
"""
import os
import socket
from types import SimpleNamespace
os.environ['INTERNAL_API_SECRET'] = 'local-social-contract-secret'
os.environ['APP_ENV'] = 'development'
import uvicorn
from api import v2
from api.main import app
from retrieval.v2_retriever import RankedRepository, RecommendationBatch

def recommend(*args):
    assert len(args) == 7, 'Rich evidence must reach the registered recommendation job.'
    evidence = args[6]
    assert len(evidence) == 1
    candidate = evidence[0]
    assert str(candidate.repo_id) == '00000000-0000-4000-8000-000000000003'
    assert candidate.owner_github_id == '123'
    assert candidate.source in {'followed_owner', 'followed_like', 'co_like', 'board_topic', 'adjacent_interest'}
    assert candidate.support == (1 if candidate.source in {'followed_owner', 'adjacent_interest'} else 2)
    assert candidate.source_score == 0.25
    return RecommendationBatch(
        items=[RankedRepository(str(candidate.repo_id), .8, 'social',
                                retrieval_scores={candidate.source: candidate.source_score})],
        model_version='contract-ranker-v2', embedding_version='contract-embedding-v2',
        ranker_applied=True, served_ranker='heavy', heavy_ranker_selected=True)

v2.retriever = lambda: SimpleNamespace(recommend_batch=recommend)
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(128)
print(f'SOCIAL_CONTRACT_PORT={listener.getsockname()[1]}', flush=True)
uvicorn.Server(uvicorn.Config(app, lifespan='off', log_level='error')).run(sockets=[listener])
