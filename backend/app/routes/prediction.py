from fastapi import APIRouter

from app.cache import get_prediction

router = APIRouter()


@router.get("/congestion/prediction")
def prediction() -> dict:
    cached = get_prediction()
    if cached is not None:
        return cached
    return {"status": "collecting", "days_collected": 0}
