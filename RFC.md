# RFCs

People put this tool in their build and asset pipelines, so some changes break them. A pull
request that changes the `smpl` chunk and WAV data it writes, the audio files it accepts, or removes a feature, gets the `rfc` label and cannot merge for
seven days, so the people who depend on it can comment first.

Bugfixes that make the output match what the tool already promises, UI changes that leave the
output alone, and new features do not need one. Who opens the pull request makes no difference.

## The window

While the label is on, the `rfc-moratorium` check fails until seven days after the label was
last applied, and `main` requires that check. The check's description gives the time the
window closes. If the proposal changes during the window, remove and re-apply the label and say
what changed in a comment; the seven days start over.

Open RFCs are the
[open pull requests with the label](https://github.com/ps1dev/loopy/pulls?q=is%3Apr+is%3Aopen+label%3Arfc).

## Commenting

Comment on the pull request. An objection helps most with a use case attached: what you do
today that the change would break.
