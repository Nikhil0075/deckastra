ARG API_IMAGE
FROM ${API_IMAGE}
CMD ["python", "-m", "alembic", "-c", "infrastructure/database/alembic.ini", "upgrade", "head"]
