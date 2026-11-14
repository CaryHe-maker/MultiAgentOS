# pyarchive (oracle)

This directory is the oracle of the pyarchive task, not a real implementation: `python3 -m pyarchive
<tool> ...` runs GNU tar, GNU gzip or Info-ZIP zip/unzip with the same arguments. It shows that the
hidden tests can be passed and fails, by design, the check that forbids external programs. A real solution
implements DEFLATE (LZ77 with hash chains, Huffman coding with length limits, block splitting), inflate,
CRC-32, and the gzip, zip and tar formats in pure Python.
