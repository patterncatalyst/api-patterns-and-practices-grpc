---
title: "Examples"
layout: plan
permalink: /examples/
description: "Every runnable example in this repo, mapped to the chapter it supports."
---

Every hands-on chapter in this site has a matching runnable example under
[`examples/`](https://github.com/{{ site.github_username }}/{{ site.github_repo }}/tree/main/examples)
in the repo. Each hands-on example ships **both** a Quarkus and a Python
implementation, generated from the same Protobuf contract, and a `verify.sh` that
calls the running service and asserts response semantics against the proto — not
just a status. The code tabs and example layout are built to admit Go and C++ later.

This table fills in as each iteration lands; see the
[coverage matrix]({{ '/plans/coverage-matrix/' | relative_url }}) for per-chapter status.

| Example | What it shows | Stacks | Chapter |
|---|---|---|---|
| [05-contract-first](https://github.com/{{ site.github_username }}/{{ site.github_repo }}/tree/main/examples/05-contract-first) | Contract-first anchor — `RoutingService.GetQuote` (unary), traced end to end | Both | [Ch5]({{ '/docs/05-contract-first-with-buf/' | relative_url }}) |
