# auth

Sign-in for the members site: password hashes, sign-in with a limit on failed attempts,
sessions, signed access tokens and avatar uploads. Python 3.11+, standard library only.

Rules the module must keep:

- A user name is not case sensitive: `Alice` and `alice` are the same account.
- Every access token expires; a token lives at most 24 hours.
- A session id cannot be guessed.
- Uploaded files stay inside the upload folder.

Tests: `python3 -m unittest discover -s tests -t .`
