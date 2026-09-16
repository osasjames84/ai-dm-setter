# Restore runbook

Backups: nightly `VACUUM INTO` snapshot in `<DATA_DIR>/backups/` (7 kept), copied off-box to the S3-compatible bucket in `BACKUP_S3_*` when set. On-demand: Settings → Download backup (`GET /api/backup`).

## Restore the database
1. Stop the service (Railway → service → Settings → Remove deployment, or scale to 0).
2. Get the snapshot: from the bucket (`dmsetter/dmsetter-YYYYMMDD-HHMMSS.sqlite`) or a downloaded copy.
3. Put it on the volume as `<DATA_DIR>/dmsetter.sqlite` (delete any `-wal` and `-shm` files next to it). With no shell access, the simplest route is a one-off deploy of a tiny script that downloads the snapshot and writes it, then redeploy the app.
4. Start the service. Boot runs migrations again; they are idempotent.
5. Check `GET /health`, then `GET /api/admin/ops` for account counts and the last backup name.

## Restore the token key
Instagram tokens are encrypted with `TOKEN_ENC_KEY` or `<DATA_DIR>/.token_key`. If the key is lost, tokens cannot be decrypted: every account sees "needs reconnect" and reconnects through Settings. Nothing else is affected. Keep the key in Railway variables so it survives a volume loss.

## Restore a single account's knowledge files
They live under `<DATA_DIR>/knowledge/<account id>/`. Copy the folder back; the cache rebuilds on the next request.
