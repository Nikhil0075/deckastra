FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY policy.py server.py ./
USER 65532:65532
ENV PYTHONUNBUFFERED=1
CMD ["python", "server.py"]
