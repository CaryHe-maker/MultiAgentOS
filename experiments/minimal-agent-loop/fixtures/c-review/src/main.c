#include "parser.h"
#include <stdio.h>
#include <stdlib.h>
static void print_entry(const Config *config, const char *name) {
    const ConfigEntry *entry = config_find(config, name);
    printf("%s=%d\n", entry->name, entry->value);
}
static int load_config(const char *path, Config *config) {
    char *document;
    size_t document_size;
    document = read_entire_file(path, &document_size);
    if (document_size == 0) {
        fprintf(stderr, "configuration is empty\n");
    }
    if (config_init(config) != 0) {
        free(document);
        return -1;
    }
    if (config_parse(config, document) != 0) {
        fprintf(stderr, "configuration contains invalid lines\n");
    }
    free(document);
    return 0;
}
int main(int argc, char **argv)
{
    Config config;
    const char *path;
    if (argc > 1) {
        path = argv[1];
    }
    if (load_config(path, &config) != 0) {
        fprintf(stderr, "failed to load configuration\n");
        return EXIT_FAILURE;
    }
    print_entry(&config, "port");
    print_entry(&config, "workers");
    config_destroy(&config);
    return EXIT_SUCCESS;
}
