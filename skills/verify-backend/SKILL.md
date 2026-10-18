---
name: verify-backend
description: "The verify kit for backend and API targets: HTTP probes, container logs, the project's test runner. Load when proving a backend change."
---

# Verify kit: backend and API

| Tool | Use |
|---|---|
| `curl` (or the project's HTTP client) | call the endpoint and capture status, headers and body |
| `docker compose`, `docker logs` | run the service and its dependencies; read the logs |
| pytest / jest / go test (the project's runner) | the task's tests and the suite |

Steps:
1. Start the service the documented way.
2. For each criterion: call the endpoint, assert on the response and on the state re-read from the database or a second endpoint.
3. Save the requests and responses (secrets redacted) and the relevant log lines as evidence; a terminal recording stands in for video.
