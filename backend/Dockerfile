FROM python:3.12-slim

# Python 로그가 즉시 출력되도록 설정
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

WORKDIR /app

# routingkit-cch 등 C/C++ 확장 패키지 빌드에 필요할 수 있는 도구
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    g++ \
    cmake \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 의존성 파일을 먼저 복사해 Docker 캐시 활용
COPY requirements.txt /app/requirements.txt

RUN python -m pip install --upgrade pip setuptools wheel \
    && pip install -r /app/requirements.txt

# 애플리케이션 소스 복사
COPY . /app

EXPOSE 5000

# 컨테이너 자체 상태 검사
HEALTHCHECK --interval=30s --timeout=10s --start-period=600s --retries=3 \
    CMD curl --fail http://localhost:5000/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]