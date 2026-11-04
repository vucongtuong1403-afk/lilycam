// dahua-pb: xem lại bản ghi Dahua qua NetSDK, xuất H.264 ra stdout
// argv: ip port user pass channel startEpoch endEpoch [seconds]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <signal.h>
#include "dhnetsdk.h"

static LLONG g_login = 0;
static LLONG g_play = 0;
static volatile int g_stop = 0;

static void on_signal(int sig) { (void)sig; g_stop = 1; }

/* Dòng dữ liệu Dahua gồm các khối 1024 byte, mỗi khối mở đầu bằng "DHAV" + 40 byte header.
   Bóc header để còn H.264/H.265 Annex-B thuần cho ffmpeg. */
static unsigned char pend[1 << 20];
static size_t pendLen = 0;

static void write_out(const unsigned char *p, size_t n) {
  if (n) { fwrite(p, 1, n, stdout); fflush(stdout); }
}

static void drain(int final) {
  size_t i = 0;
  while (i + 4 <= pendLen) {
    if (memcmp(pend + i, "DHAV", 4) == 0) {
      if (i > 0) { write_out(pend, i); }
      if (pendLen - i < 44) { memmove(pend, pend + i, pendLen - i); pendLen -= i; return; }
      memmove(pend, pend + i + 44, pendLen - i - 44);
      pendLen -= i + 44;
      i = 0;
      continue;
    }
    i++;
  }
  if (i > 0) { write_out(pend, i); memmove(pend, pend + i, pendLen - i); pendLen -= i; }
  if (final && pendLen) { write_out(pend, pendLen); pendLen = 0; }
}

static unsigned long long g_bytes[8];
static unsigned long long g_calls[8];
static int CALLBACK data_cb(LLONG h, DWORD type, BYTE *buf, DWORD size, LDWORD user) {
  (void)h; (void)user;
  if (type < 8) { g_calls[type]++; g_bytes[type] += size; }
  if (type == 0 && size > 0 && buf) {
    if (pendLen + size > sizeof(pend)) drain(0);
    if (size <= sizeof(pend) - pendLen) {
      memcpy(pend + pendLen, buf, size);
      pendLen += size;
      drain(0);
    }
  }
  return 0;
}

static void CALLBACK pos_cb(LLONG h, DWORD total, int cur, LDWORD user) {
  (void)h; (void)total; (void)cur; (void)user;
}

static void CALLBACK dis_cb(LLONG login, char *ip, int port, LDWORD user) {
  (void)login; (void)ip; (void)port; (void)user;
  g_stop = 1;
}

static void to_net_time(time_t t, NET_TIME *nt) {
  struct tm tm;
  localtime_r(&t, &tm);
  nt->dwYear = tm.tm_year + 1900;
  nt->dwMonth = tm.tm_mon + 1;
  nt->dwDay = tm.tm_mday;
  nt->dwHour = tm.tm_hour;
  nt->dwMinute = tm.tm_min;
  nt->dwSecond = tm.tm_sec;
}

static time_t from_net_time(const NET_TIME *nt) {
  struct tm tm;
  memset(&tm, 0, sizeof(tm));
  tm.tm_year = (int)nt->dwYear - 1900;
  tm.tm_mon = (int)nt->dwMonth - 1;
  tm.tm_mday = (int)nt->dwDay;
  tm.tm_hour = (int)nt->dwHour;
  tm.tm_min = (int)nt->dwMinute;
  tm.tm_sec = (int)nt->dwSecond;
  tm.tm_isdst = -1;
  return mktime(&tm);
}

int main(int argc, char **argv) {
  if (argc < 8) {
    fprintf(stderr, "usage: %s ip port user pass channel startEpoch endEpoch [maxSec]\n", argv[0]);
    return 64;
  }
  const char *ip = argv[1];
  int port = atoi(argv[2]);
  const char *user = argv[3];
  const char *pass = argv[4];
  int channel = atoi(argv[5]);
  time_t start = (time_t)atoll(argv[6]);
  time_t end = (time_t)atoll(argv[7]);
  int maxsec = argc > 8 ? atoi(argv[8]) : 3600;

  signal(SIGTERM, on_signal);
  signal(SIGINT, on_signal);
  signal(SIGPIPE, SIG_IGN);

  CLIENT_Init(dis_cb, 0);
  CLIENT_SetAutoReconnect(NULL, 0);

  NET_IN_LOGIN_WITH_HIGHLEVEL_SECURITY in;
  NET_OUT_LOGIN_WITH_HIGHLEVEL_SECURITY out;
  memset(&in, 0, sizeof(in));
  memset(&out, 0, sizeof(out));
  in.dwSize = sizeof(in);
  snprintf(in.szIP, sizeof(in.szIP), "%s", ip);
  in.nPort = port;
  snprintf(in.szUserName, sizeof(in.szUserName), "%s", user);
  snprintf(in.szPassword, sizeof(in.szPassword), "%s", pass);
  in.emSpecCap = EM_LOGIN_SPEC_CAP_TCP;
  out.dwSize = sizeof(out);

  g_login = CLIENT_LoginWithHighLevelSecurity(&in, &out);
  if (!g_login) {
    fprintf(stderr, "login failed: %d\n", out.nError);
    CLIENT_Cleanup();
    return 2;
  }
  fprintf(stderr, "logged in\n");

  NET_TIME st, sp;
  memset(&st, 0, sizeof(st));
  memset(&sp, 0, sizeof(sp));
  to_net_time(start, &st);
  to_net_time(end, &sp);

  const char *listMode = getenv("PB_LIST");
  if (listMode && *listMode) {
    int cap = 4096;
    const char *ftEnv = getenv("PB_LIST_TYPE");
    int ftype = ftEnv ? atoi(ftEnv) : 0;
    NET_RECORDFILE_INFO *infos = (NET_RECORDFILE_INFO *)calloc((size_t)cap, sizeof(NET_RECORDFILE_INFO));
    int count = 0;
    BOOL ok = CLIENT_QueryRecordFile(g_login, channel, ftype, &st, &sp, NULL, infos, (int)(cap * sizeof(NET_RECORDFILE_INFO)), &count, 15000);
    if (!ok) { fprintf(stderr, "query failed: %d\n", CLIENT_GetLastError()); }
    if (count > cap) count = cap;
    printf("[");
    for (int i = 0; i < count; i++) {
      long a = (long)from_net_time(&infos[i].starttime);
      long b = (long)from_net_time(&infos[i].endtime);
      if (b > a) printf("%s{\"s\":%ld,\"e\":%ld}", i ? "," : "", a, b);
    }
    printf("]\n");
    fflush(stdout);
    free(infos);
    CLIENT_Logout(g_login);
    CLIENT_Cleanup();
    return 0;
  }

  const char *dls = getenv("PB_DLSTREAM");
  if (dls && *dls) {
    g_play = CLIENT_DownloadByTimeEx(g_login, channel, 0, &st, &sp, NULL, NULL, 0, data_cb, 0, NULL);
    if (!g_play) { fprintf(stderr, "download stream failed: %d\n", CLIENT_GetLastError()); return 3; }
    fprintf(stderr, "download streaming\n");
    time_t t0 = time(NULL);
    while (!g_stop && time(NULL) - t0 < maxsec) {
      sleep(1);
      if (end > 0 && time(NULL) > end + 5) break;
    }
    drain(1);
    for (int i = 0; i < 8; i++)
      if (g_calls[i]) fprintf(stderr, "type %d: %llu calls, %llu bytes\n", i, g_calls[i], g_bytes[i]);
    CLIENT_StopDownload(g_play);
    CLIENT_Logout(g_login);
    CLIENT_Cleanup();
    return 0;
  }

  const char *dl = getenv("PB_DOWNLOAD");
  if (dl && *dl) {
    g_play = CLIENT_DownloadByTime(g_login, channel, 0, &st, &sp, (char *)dl, NULL, 0);
    if (!g_play) { fprintf(stderr, "download failed: %d\n", CLIENT_GetLastError()); return 3; }
    fprintf(stderr, "downloading to %s\n", dl);
    time_t t0 = time(NULL);
    while (!g_stop) {
      sleep(1);
      int total = 0, done = 0;
      if (CLIENT_GetDownloadPos(g_play, &total, &done) && total > 0 && done >= total) break;
      if (time(NULL) - t0 > maxsec + 60) break;
    }
    CLIENT_StopDownload(g_play);
    CLIENT_Logout(g_login);
    CLIENT_Cleanup();
    return 0;
  }
  g_play = CLIENT_PlayBackByTimeEx(g_login, channel, &st, &sp, 0, pos_cb, 0, data_cb, 0);
  if (!g_play) {
    fprintf(stderr, "playback failed: %d\n", CLIENT_GetLastError());
    CLIENT_Logout(g_login);
    CLIENT_Cleanup();
    return 3;
  }
  fprintf(stderr, "playing\n");
  const char *spd = getenv("PB_SPEED");
  if (spd) {
    int v = atoi(spd);
    CLIENT_SetPlayBackSpeed(g_play, (EM_PLAY_BACK_SPEED)v);
    fprintf(stderr, "speed=%d\n", v);
  }

  time_t began = time(NULL);
  while (!g_stop) {
    sleep(1);
    if (time(NULL) - began > maxsec) break;
    if (end > 0 && time(NULL) > end) break;
  }

  drain(1);
  for (int i = 0; i < 8; i++)
    if (g_calls[i]) fprintf(stderr, "type %d: %llu calls, %llu bytes\n", i, g_calls[i], g_bytes[i]);
  CLIENT_StopPlayBack(g_play);
  CLIENT_Logout(g_login);
  CLIENT_Cleanup();
  return 0;
}
