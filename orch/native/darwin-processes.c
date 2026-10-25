// Read-only macOS process evidence. No signals, commands, environment or credentials.
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <limits.h>

int main(int argc, char **argv) {
  char boot[128] = {0}; size_t bootlen = sizeof boot;
  if (sysctlbyname("kern.bootsessionuuid", boot, &bootlen, NULL, 0) || strlen(boot) != 36) return 1;
  for (char *p = boot; *p; ++p) {
    if (*p >= 'A' && *p <= 'F') *p += 'a' - 'A';
    if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f') || *p == '-')) return 1;
  }
  int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 };
  if (argc > 2) return 2;
  if (argc == 2) {
    char *end; errno = 0; long pid = strtol(argv[1], &end, 10);
    if (errno || *end || pid <= 0 || pid > INT_MAX) return 2;
    mib[2] = KERN_PROC_PID; mib[3] = (int)pid;
  }
  struct kinfo_proc *rows = NULL; size_t size = 0;
  // Processes can appear between the size query and the snapshot. Bounded retries.
  for (int attempt = 0; attempt < 4; ++attempt) {
    free(rows); rows = NULL;
    if (sysctl(mib, 4, NULL, &size, NULL, 0)) return 1;
    size += 64 * sizeof(struct kinfo_proc);
    rows = malloc(size); if (!rows) return 1;
    if (!sysctl(mib, 4, rows, &size, NULL, 0)) break;
    if (errno != ENOMEM || attempt == 3) { free(rows); return 1; }
  }
  struct timeval now; if (gettimeofday(&now, NULL)) { free(rows); return 1; }
  printf("{\"clockScope\":\"darwin:%s\",\"now\":\"darwin:%s:%lld\",\"rows\":[", boot, boot,
    (long long)now.tv_sec * 1000000 + now.tv_usec);
  int comma = 0;
  for (size_t i = 0; i < size / sizeof(*rows); ++i) {
    struct kinfo_proc *p = &rows[i];
    if (p->kp_proc.p_pid <= 0) continue;
    long long birth = (long long)p->kp_proc.p_starttime.tv_sec * 1000000 + p->kp_proc.p_starttime.tv_usec;
    // Missing native evidence invalidates the snapshot; never turn it into absence.
    if (birth <= 0) { free(rows); return 1; }
    pid_t session = getsid(p->kp_proc.p_pid);
    // A process may exit after the snapshot. Unknown session cannot authorize group kill.
    printf("%s{\"pid\":%d,\"ppid\":%d,\"pgrp\":%d,\"session\":%d,\"name\":\"\",\"state\":\"%s\",\"createdAt\":\"darwin:%s:%lld\"}",
      comma++ ? "," : "", p->kp_proc.p_pid, p->kp_eproc.e_ppid, p->kp_eproc.e_pgid,
      session, p->kp_proc.p_stat == SZOMB ? "Z" : p->kp_proc.p_stat == SSTOP ? "T" : "R", boot, birth);
  }
  free(rows); puts("]}"); return 0;
}
