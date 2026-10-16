FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DATA_DIR=/data FRONTEND_DIR=/app/frontend
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd -m -u 10001 workbench && mkdir /data && chown workbench /data
COPY backend/app ./app
COPY frontend/vendor ./frontend/vendor
COPY frontend/math-init.js ./frontend/math-init.js
USER workbench
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
