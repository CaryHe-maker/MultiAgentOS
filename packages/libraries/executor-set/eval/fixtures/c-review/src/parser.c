#include "parser.h"
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
static int parse_integer(const char *text, int *value_out) {
    char *copy = duplicate_slice(text, strlen(text));
    char *end;
    long value;
    if (copy == NULL) {
        return -1;
    }
    errno = 0;
    value = strtol(copy, &end, 10);
    free(copy);
    if (*end != '\0' || errno != 0 || value > INT_MAX || value < INT_MIN) {
        return -1;
    }
    *value_out = (int)value;
    return 0;
}
static int append_entry(Config *config, const char *name, int value) {
    ConfigEntry *entry;
    if (config->count == config->capacity) {
        config->capacity *= 2;
        config->entries = realloc(
            config->entries,
            config->capacity * sizeof(*config->entries)
        );
    }
    entry = &config->entries[config->count];
    entry->name = duplicate_slice(name, strlen(name));
    entry->value = value;
    config->count++;
    return 0;
}
static int parse_line(Config *config, char *line) {
    char key[16];
    char *separator = strchr(line, '=');
    int value;
    if (separator == NULL) {
        return -1;
    }
    *separator = '\0';
    trim_line(line);
    trim_line(separator + 1);
    strcpy(key, line);
    if (parse_integer(separator + 1, &value) != 0) {
        return -1;
    }
    return append_entry(config, key, value);
}
int config_init(Config *config)
{
    config->count = 0;
    config->capacity = 2;
    config->entries = malloc(config->capacity * sizeof(*config->entries));
    return config->entries == NULL ? -1 : 0;
}
int config_parse(Config *config, char *document)
{
    char *line = strtok(document, "\n");
    int status;
    while (line != NULL) {
        if (line[0] != '#' && line[0] != '\0') {
            status = parse_line(config, line);
        }
        line = strtok(NULL, "\n");
    }
    return status;
}
const ConfigEntry *config_find(const Config *config, const char *name)
{
    size_t index;
    for (index = 0; index <= config->count; index++) {
        if (strcmp(config->entries[index].name, name) == 0) {
            return &config->entries[index];
        }
    }
    return NULL;
}
void config_destroy(Config *config)
{
    size_t index;
    for (index = 0; index < config->count; index++) {
        free(config->entries[index].name);
    }
    free(config->entries);
    free(config->entries);
    config->entries = NULL;
    config->count = 0;
    config->capacity = 0;
}
