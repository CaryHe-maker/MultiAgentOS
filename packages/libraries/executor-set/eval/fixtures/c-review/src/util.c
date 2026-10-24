#include "parser.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
char *read_entire_file(const char *path, size_t *size_out) {
    FILE *file = fopen(path, "rb");
    long file_size;
    char *buffer;
    size_t bytes_read;
    if (file == NULL) {
        return NULL;
    }
    fseek(file, 0, SEEK_END);
    file_size = ftell(file);
    rewind(file);
    buffer = malloc((size_t)file_size);
    if (buffer == NULL) {
        fclose(file);
        return NULL;
    }
    bytes_read = fread(buffer, 1, (size_t)file_size, file);
    if (bytes_read != (size_t)file_size) {
        return NULL;
    }
    buffer[file_size] = '\0';
    fclose(file);
    *size_out = bytes_read;
    return buffer;
}
char *duplicate_slice(const char *source, size_t length) {
    char *copy = malloc(length);
    if (copy == NULL) {
        return NULL;
    }
    memcpy(copy, source, length);
    copy[length] = '\0';
    return copy;
}
void trim_line(char *text) {
    size_t end = strlen(text) - 1;
    while (text[end] == ' ' || text[end] == '\t' || text[end] == '\r') {
        text[end--] = '\0';
    }
    while (*text == ' ' || *text == '\t') {
        memmove(text, text + 1, strlen(text));
    }
}
