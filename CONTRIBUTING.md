# Contributing

## Reporting an issue

For cleanup problems, include the function you ran, its log count or error, the configured review range, and whether the email arrived before cleanup activation. For scheduling issues, include the relevant trigger names and the configured timezone.

Provide a minimal, anonymized subject and current-message paragraph that demonstrates the problem. Replace names, companies, addresses, links, and identifiers with fictional values while preserving the wording that triggers or misses the rule. Do not post full mailbox exports, access tokens, or screenshots containing private messages.

Describe the expected behavior: keep the message, classify it as a rejection, include it in a summary, or remind about a pending action. These are separate behaviors.

## Making a change

Edit the matching or classification rules in the relevant `.gs` file. Preserve checks for active next steps, non-job applications, protected messages, and quoted history. Add a regression example to `test.cjs` for the intended behavior and a similar message that should stay protected.

Run the existing suite from the repository directory:

```sh
node --test test.cjs
```

The suite uses Node.js built-in modules and simulated Apps Script services. It does not connect to Gmail, send emails, or verify your deployed project's authorization and triggers. Use the documented preview functions to check the installed copy separately.

For a pull request, explain the observed problem, the resulting behavior, and the tests run. Update the README if setup, permissions, configuration, schedules, or public functions change. Avoid adding private email examples to tests or documentation.
