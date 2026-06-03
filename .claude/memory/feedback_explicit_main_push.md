# Explicit Main Pushes

Only push to `main` when the user explicitly asks for that exact direct push in
the current turn. Do not infer permission from prior direct pushes, broad
"push" wording, or surrounding urgency. Default to a branch/PR path unless the
user clearly says to push to `main` this time.
