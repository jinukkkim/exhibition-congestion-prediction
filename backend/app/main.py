from fastapi import FastAPI

app = FastAPI(title="Exhibition Congestion Prediction")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
