<!-- padakan:disk:start -->
# Disk: 10 GB is the ceiling

This sandbox has at most 10 GB of disk (Daytona's per-sandbox limit unless support raises it), fixed when the snapshot was baked. Work within it; do not report it as a misconfiguration.

- Check between stages: `df -Pm /`.
- When free space drops under ~1500 MB, delete regenerable caches (package-manager caches, downloaded models under `/tmp`, build output) before anything else.
- **Never `rm -rf /tmp/*`**: Claude's own sockets live under `/tmp`.
- Commit and push before a heavy step, so a full disk never costs work.
- A gate too big for this disk runs in the PR's CI instead. If the disk wedges, stop and report `BLOCKED=disk full` with the `df` output.
<!-- padakan:disk:end -->
