-- 0009_job_heartbeat: liveness of the process that runs a job.
--
-- Jobs run inside the API process. With more than one replica (or an old and a new revision side by
-- side during a rollout) "a job nobody is running" can no longer be told from "a job another replica is
-- running" by its status alone. The process that owns a job refreshes heartbeat_at every few seconds;
-- only a job whose last sign of life (heartbeat, else start, else creation) is older than the staleness
-- threshold is failed as orphaned. The same round trip tells the owner when the job was cancelled on
-- another replica. NULL means "no heartbeat yet", which readers treat as the job's start or creation time.
ALTER TABLE jobs ADD COLUMN heartbeat_at timestamptz;
