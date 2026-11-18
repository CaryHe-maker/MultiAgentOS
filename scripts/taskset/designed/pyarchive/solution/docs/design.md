# pyarchive oracle design

The oracle replaces the process with the reference tool, so archives, listings and exit codes are the
reference implementations'. This validates the comparisons in the hidden tests, not compression logic.
A real implementation follows RFC 1951 (block types, code length alphabets, the length/distance tables),
RFC 1952 (header flags, multi-member files), PKWARE APPNOTE (local headers, central directory, data
descriptors, DOS times, external attributes) and POSIX ustar with the GNU and pax extensions.
