# Slim Python + git image. The runtime needs python (the server) and git
# (status collection + sync push/pull + worktree materialization).
# OpenSSH client is required for git+ssh remotes; ca-certificates for https.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ship the code so the image is usable standalone (no host-side checkout
# required just to run the dashboard). The compose file mounts a host
# checkout over /app for users who want sync to push back to git.
COPY agent_workspace.py /app/
COPY awlib/ /app/awlib/
COPY static/ /app/static/
COPY bin/ /app/bin/
COPY data/ /app/data/
RUN chmod +x /app/bin/*

EXPOSE 8765

# tini reaps zombies (subprocess.Popen for git/etc) and forwards signals
# cleanly so `docker stop` / `podman stop` shuts the server down on time.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "-u", "/app/agent_workspace.py", \
     "--no-open", \
     "--bind", "0.0.0.0", \
     "--port", "8765", \
     "--worktrees", "/worktrees", \
     "--primaries", "/primaries"]
