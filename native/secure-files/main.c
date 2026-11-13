/* Every path reaching this helper has already passed the server's policy.
 * Resolve it from / through pinned directory fds, never through mutable parent
 * pathnames. No component, including root ancestry, may be a symlink here. */
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#define _POSIX_C_SOURCE 200809L
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_BYTES (100U * 1024U * 1024U)
#define MAX_ENTRIES 5000U
static int cleanup_parent = -1;
static char cleanup_name[NAME_MAX + 1];

static void refuse(const char *code) {
  if (cleanup_parent >= 0 && cleanup_name[0]) unlinkat(cleanup_parent, cleanup_name, 0);
  fprintf(stderr, "%s\n", code);
  exit(1);
}
static void os_error(void) {
  int code = errno;
  if (code == ELOOP || code == ENOTDIR || code == ENAMETOOLONG) refuse("invalid_path");
  if (code == ENOENT) refuse("not_found");
  if (code == EISDIR) refuse("not_file");
  refuse("io");
}
static void check_component(const char *part) {
  if (!part[0] || !strcmp(part, ".") || !strcmp(part, "..")) refuse("invalid_path");
}
/* This also pins all ancestors of the authorized root. A directory exchanged
 * after openat stays the authorized object; a replacement link is refused. */
static int directory(const char *absolute, int create) {
  if (absolute[0] != '/' || strlen(absolute) > 8192) refuse("invalid_path");
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) os_error();
  char *copy = strdup(absolute);
  if (!copy) refuse("io");
  char *cursor = NULL;
  for (char *part = strtok_r(copy, "/", &cursor); part; part = strtok_r(NULL, "/", &cursor)) {
    check_component(part);
    if (create && mkdirat(fd, part, 0700) < 0 && errno != EEXIST) os_error();
    int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) os_error();
    close(fd);
    fd = next;
  }
  free(copy);
  return fd;
}
static int parent_of(const char *absolute, char **leaf) {
  if (absolute[0] != '/' || strlen(absolute) > 8192) refuse("invalid_path");
  char *copy = strdup(absolute);
  if (!copy) refuse("io");
  char *slash = strrchr(copy, '/');
  *leaf = strdup(slash[1] ? slash + 1 : ".");
  if (!*leaf) refuse("io");
  if (slash == copy) slash[1] = '\0'; else *slash = '\0';
  int fd = directory(copy, 0);
  free(copy);
  return fd;
}
static const char *kind(const struct stat *info) {
  if (S_ISLNK(info->st_mode)) refuse("invalid_path");
  if (S_ISREG(info->st_mode)) return "file";
  if (S_ISDIR(info->st_mode)) return "directory";
  refuse("not_file");
  return NULL;
}
static void json_string(const char *text) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (*p == '"' || *p == '\\') printf("\\%c", *p);
    else if (*p < 32) printf("\\u%04x", (unsigned int)*p);
    else putchar(*p);
  }
  putchar('"');
}
static void file_stat(const char *path) {
  char *leaf;
  int fd = parent_of(path, &leaf);
  struct stat info;
  if (fstatat(fd, leaf, &info, AT_SYMLINK_NOFOLLOW) < 0) os_error();
#ifdef __APPLE__
  double modified = info.st_mtimespec.tv_sec * 1000.0 + info.st_mtimespec.tv_nsec / 1000000.0;
#else
  double modified = info.st_mtim.tv_sec * 1000.0 + info.st_mtim.tv_nsec / 1000000.0;
#endif
  printf("{\"type\":\"%s\",\"size\":%lld,\"modified\":%.3f}", kind(&info), (long long)info.st_size, modified);
  close(fd);
  free(leaf);
}
static void list(const char *path) {
  int fd = directory(path, 0);
  DIR *stream = fdopendir(fd);
  if (!stream) os_error();
  unsigned int scanned = 0;
  int first = 1, truncated = 0;
  printf("{\"entries\":[");
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (!entry) { if (errno) os_error(); break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++scanned > MAX_ENTRIES) { truncated = 1; break; }
    struct stat info;
    if (fstatat(fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) < 0) {
      if (errno == ENOENT) continue;
      os_error();
    }
    if (!S_ISREG(info.st_mode) && !S_ISDIR(info.st_mode)) continue;
    if (!first) putchar(',');
    first = 0;
    printf("{\"name\":");
    json_string(entry->d_name);
    printf(",\"type\":\"%s\",\"size\":%lld}", kind(&info), S_ISDIR(info.st_mode) ? 0LL : (long long)info.st_size);
  }
  printf("],\"truncated\":%s}", truncated ? "true" : "false");
  closedir(stream);
}
static void file_read(const char *path, size_t limit) {
  char *leaf;
  int parent = parent_of(path, &leaf);
  int fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) os_error();
  close(parent);
  free(leaf);
  struct stat info;
  if (fstat(fd, &info) < 0) os_error();
  if (!S_ISREG(info.st_mode)) refuse("not_file");
  printf("{\"size\":%lld}\n", (long long)info.st_size);
  unsigned char buffer[65536];
  size_t total = 0;
  while (total < limit) {
    size_t count = limit - total < sizeof(buffer) ? limit - total : sizeof(buffer);
    ssize_t n = read(fd, buffer, count);
    if (n < 0) { if (errno == EINTR) continue; os_error(); }
    if (!n) break;
    total += (size_t)n;
    if (total > (uint64_t)info.st_size) refuse("invalid_data");
    if (fwrite(buffer, 1, (size_t)n, stdout) != (size_t)n) refuse("io");
  }
  close(fd);
}
static void temp_name(char *output, size_t size) {
  unsigned char entropy[16];
  int source = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (source < 0) os_error();
  size_t offset = 0;
  while (offset < sizeof(entropy)) {
    ssize_t n = read(source, entropy + offset, sizeof(entropy) - offset);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) refuse("io");
    offset += (size_t)n;
  }
  close(source);
  if (size < 40) refuse("io");
  memcpy(output, ".clave-", 7);
  for (size_t i = 0; i < sizeof(entropy); i++) sprintf(output + 7 + 2 * i, "%02x", entropy[i]);
}
static void file_write(const char *path, size_t limit, int replace) {
  char *leaf;
  int parent = parent_of(path, &leaf);
  check_component(leaf);
  struct stat previous;
  mode_t mode = 0600;
  if (replace) {
    if (fstatat(parent, leaf, &previous, AT_SYMLINK_NOFOLLOW) == 0) {
      if (!S_ISREG(previous.st_mode)) refuse(S_ISLNK(previous.st_mode) ? "invalid_path" : "not_file");
      mode = previous.st_mode & 0777;
    } else if (errno != ENOENT) os_error();
  }
  char temporary[128];
  if (replace) temp_name(temporary, sizeof(temporary));
  const char *name = replace ? temporary : leaf;
  int fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) os_error();
  cleanup_parent = parent;
  snprintf(cleanup_name, sizeof(cleanup_name), "%s", name);
  /* A created leaf can be up to NAME_MAX, unlike our short temp name. */
  if (strlen(name) >= sizeof(cleanup_name)) { close(fd); unlinkat(parent, name, 0); refuse("invalid_path"); }
  if (fchmod(fd, mode) < 0) os_error();
  unsigned char buffer[65536];
  size_t total = 0;
  for (;;) {
    ssize_t n = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (n < 0) { if (errno == EINTR) continue; os_error(); }
    if (!n) break;
    total += (size_t)n;
    if (total > limit) refuse("too_large");
    size_t done = 0;
    while (done < (size_t)n) {
      ssize_t written = write(fd, buffer + done, (size_t)n - done);
      if (written < 0) { if (errno == EINTR) continue; os_error(); }
      if (!written) refuse("io");
      done += (size_t)written;
    }
  }
  if (total != limit) refuse("invalid_data");
  if (close(fd) < 0) os_error();
  if (replace && renameat(parent, temporary, parent, leaf) < 0) os_error();
  cleanup_name[0] = '\0';
  cleanup_parent = -1;
  close(parent);
  free(leaf);
}
int main(int argc, char **argv) {
  umask(0077);
  if (argc != 4 || argv[2][0] != '/') refuse("invalid_data");
  char *end;
  errno = 0;
  unsigned long long limit = strtoull(argv[3], &end, 10);
  if (errno || !argv[3][0] || *end || limit > MAX_BYTES + 1ULL) refuse("invalid_data");
  if (!strcmp(argv[1], "read")) file_read(argv[2], (size_t)limit);
  else if (!strcmp(argv[1], "stat")) file_stat(argv[2]);
  else if (!strcmp(argv[1], "list")) list(argv[2]);
  else if (!strcmp(argv[1], "write")) file_write(argv[2], (size_t)limit, 1);
  else if (!strcmp(argv[1], "create")) file_write(argv[2], (size_t)limit, 0);
  else if (!strcmp(argv[1], "mkdirp")) close(directory(argv[2], 1));
  else if (!strcmp(argv[1], "mkdir")) {
    char *leaf;
    int parent = parent_of(argv[2], &leaf);
    check_component(leaf);
    if (mkdirat(parent, leaf, 0700) < 0) os_error();
    close(parent);
    free(leaf);
  } else refuse("invalid_data");
  if (fflush(stdout) != 0) refuse("io");
  return 0;
}
