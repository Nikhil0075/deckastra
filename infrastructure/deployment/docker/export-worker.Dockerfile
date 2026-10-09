ARG API_IMAGE
FROM ${API_IMAGE}
ENV DECKASTRA_SERVICE=export-worker
CMD ["python", "-m", "deckastra_api.cloud_entrypoint"]
