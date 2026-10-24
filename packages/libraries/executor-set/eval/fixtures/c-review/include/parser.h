#ifndef PARSER_H
#define PARSER_H
#include <stddef.h>
typedef struct {
    char *name;
    int value;
} ConfigEntry;
typedef struct {
    ConfigEntry *entries;
    size_t count;
    size_t capacity;
} Config;
char *read_entire_file(const char *path, size_t *size_out);
char *duplicate_slice(const char *source, size_t length);
void trim_line(char *text);
int config_init(Config *config);
int config_parse(Config *config, char *document);
const ConfigEntry *config_find(const Config *config, const char *name);
void config_destroy(Config *config);
#endif
