const xml2js = require("xml2js");
const fs = require("fs");
const core = require("@actions/core");
const github = require("@actions/github");

fs.readFileAsync = (filename) =>
  new Promise((resolve, reject) => {
    fs.readFile(filename, { encoding: "utf-8" }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(`${data}`.replace("\ufeff", ""));
      }
    });
  });

fs.writeFileAsync = (filename, content) =>
  new Promise((resolve, reject) => {
    fs.writeFile(filename, content, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(`${data}`.replace("\ufeff", ""));
      }
    });
  });

const parser = new xml2js.Parser(/* options */);

async function readFile(filename) {
  return parser.parseStringPromise(await fs.readFileAsync(filename));
}

function calcRate({ total, covered }) {
  return total ? Number((covered / total) * 100).toFixed(2) * 1 : 0;
}

function readMetric(coverage) {
  const data = coverage.coverage.project[0].metrics[0].$;
  const metric = {
    statements: {
      total: data.elements * 1,
      covered: data.coveredelements * 1,
    },
    lines: {
      total: data.statements * 1,
      covered: data.coveredstatements * 1,
    },
    methods: {
      total: data.methods * 1,
      covered: data.coveredmethods * 1,
    },
    branches: {
      total: data.conditionals * 1,
      covered: data.coveredconditionals * 1,
    },
  };

  metric.statements.rate = calcRate(metric.statements);
  metric.lines.rate = calcRate(metric.lines);
  metric.methods.rate = calcRate(metric.methods);
  metric.branches.rate = calcRate(metric.branches);
  metric.averageRate =
    [
      metric.statements.rate,
      metric.lines.rate,
      metric.methods.rate,
      metric.branches.rate,
    ].reduce((a, b) => a + b) / 4;
  return metric;
}

function generateBadgeUrl(metric) {
  const color = metric.averageRate > 50 ? "green" : "red";
  return `https://img.shields.io/static/v1?label=coverage&message=${Math.round(
    metric.averageRate
  )}%&color=${color}`;
}

function generateEmoji(metric) {
  return metric.averageRate > 50 ? " 🎉" : "";
}

function generateInfo({ rate, total, covered }) {
  return `${rate}% ( ${covered} / ${total} )`;
}

function generateCommentHeader({ commentContext }) {
  return `<!-- coverage: ${commentContext} -->`;
}

function generateTable({ metric, commentContext }) {
  return `${generateCommentHeader({ commentContext })}
## ${commentContext}${generateEmoji(metric)}
|  Totals | ![Coverage](${generateBadgeUrl(metric)}) |
| :-- | --: |
| Statements: | ${generateInfo(metric.statements)} |
| Methods: | ${generateInfo(metric.methods)} |
| Lines: | ${generateInfo(metric.methods)} |
| Branches: | ${generateInfo(metric.branches)} |
`;
}

function generateStatus({ metric, targetUrl, statusContext, originalMetric }) {
  const {
    lines: { rate: lineRate },
    statements: { rate: statementsRate },
    methods: { rate: methodsRate },
    branches: { rate: branchesRate },
  } = metric;
  if (originalMetric) {
    const {
      lines: { rate: originalLineRate },
      statements: { rate: originalStatementsRate },
      methods: { rate: originalMethodsRate },
      branches: { rate: originalBranchesRate },
    } = originalMetric;
    core.info(JSON.stringify(originalMetric));
    core.info(JSON.stringify(metric));
    if (
      originalBranchesRate > branchesRate ||
      originalLineRate > lineRate ||
      originalMethodsRate > methodsRate ||
      originalStatementsRate > statementsRate
    ) {
      let description = "Failure: ";
      if (originalBranchesRate > branchesRate) {
        description += `Branches Coverage decrease - ${
          originalBranchesRate - branchesRate
        }%,`;
      }
      if (originalLineRate > lineRate) {
        description += `Line Coverage decrease - ${
          originalLineRate - lineRate
        }%,`;
      }
      if (originalMethodsRate > methodsRate) {
        description = `Methods Coverage decrease - ${
          originalMethodsRate - methodsRate
        }%,`;
      }
      if (originalStatementsRate > statementsRate) {
        description += `Statements Coverage decrease - ${
          originalStatementsRate - statementsRate
        }%,`;
      }
      return {
        state: "failure",
        description,
        target_url: targetUrl,
        context: statusContext,
      };
    }
  }
  return {
    state: "success",
    description: `Success: Line Coverage - ${lineRate}%, Statement Coverage - ${statementsRate}%, Methods Coverage - ${methodsRate}%,\Branchs Coverage - ${branchesRate}%`,
    target_url: targetUrl,
    context: statusContext,
  };
}

function toBool(value) {
  return typeof value === "boolean" ? value : value === "true";
}

function toInt(value) {
  return value * 1;
}

function loadConfig({ getInput }) {
  const comment = toBool(getInput("comment"));
  const check = toBool(getInput("check"));
  const githubToken = process.env.GITHUB_TOKEN;
  const cloverFile = getInput("clover_file", { required: true });
  const originalCloverFile = getInput("original_clover_file", {
    required: true,
  });
  const thresholdAlert = toInt(getInput("threshold_alert") || 90);
  const thresholdWarning = toInt(getInput("threshold_warning") || 50);
  const statusContext = getInput("status_context") || "Coverage Report";
  const commentContext = getInput("comment_context") || "Coverage Report";
  let commentMode = getInput("comment_mode");

  if (!["replace", "update", "insert"].includes(commentMode)) {
    commentMode = "replace";
  }

  return {
    comment,
    check,
    githubToken,
    cloverFile,
    thresholdAlert,
    thresholdWarning,
    statusContext,
    commentContext,
    commentMode,
    originalCloverFile,
  };
}

function parseWebhook(request) {
  const {
    payload: {
      pull_request: {
        number: prNumber,
        html_url: prUrl,
        head: { sha } = {},
      } = {},
    } = {},
  } = request || {};

  if (!prNumber || !prUrl || !sha) {
    throw new Error("Action supports only pull_request event");
  }

  return {
    prNumber,
    prUrl,
    sha,
  };
}

const createStatus = async ({ client, context, sha, status }) =>
  client.repos.createCommitStatus({
    ...context.repo,
    sha,
    ...status,
  });

const listComments = async ({ client, context, prNumber, commentHeader }) => {
  const { data: existingComments } = await client.issues.listComments({
    ...context.repo,
    issue_number: prNumber,
  });

  return existingComments.filter(({ body }) => body.startsWith(commentHeader));
};

const insertComment = async ({ client, context, prNumber, body }) =>
  client.issues.createComment({
    ...context.repo,
    issue_number: prNumber,
    body,
  });

const updateComment = async ({ client, context, body, commentId }) =>
  client.issues.updateComment({
    ...context.repo,
    comment_id: commentId,
    body,
  });

const deleteComments = async ({ client, context, comments }) =>
  Promise.all(
    comments.map(({ id }) =>
      client.issues.deleteComment({
        ...context.repo,
        comment_id: id,
      })
    )
  );

const upsertComment = async ({
  client,
  context,
  prNumber,
  body,
  existingComments,
}) => {
  const last = existingComments.pop();

  await deleteComments({
    client,
    context,
    comments: existingComments,
  });

  return last
    ? updateComment({
        client,
        context,
        body,
        commentId: last.id,
      })
    : insertComment({
        client,
        context,
        prNumber,
        body,
      });
};

const replaceComment = async ({
  client,
  context,
  prNumber,
  body,
  existingComments,
}) => {
  await deleteComments({
    client,
    context,
    comments: existingComments,
  });

  return insertComment({
    client,
    context,
    prNumber,
    body,
  });
};

async function run() {
  try {
    const { context = {} } = github || {};
    const { prNumber, prUrl, sha } = parseWebhook(context);
    const {
      githubToken,
      cloverFile,
      statusContext,
      originalCloverFile,
      commentContext,
    } = loadConfig(core);
    if (core.isDebug()) {
      core.debug("Handle webhook request");
      console.log(context);
    }

    const client = github.getOctokit(githubToken);

    const coverage = await readFile(cloverFile);
    const metric = readMetric(coverage);
    let originalMetric;
    if (fs.existsSync(originalCloverFile)) {
      const originCoverage = await readFile(originalCloverFile);
      originalMetric = readMetric(originCoverage);
    }

    const message = generateTable({ metric, commentContext });

    await replaceComment({
      client,
      context,
      prNumber,
      body: message,
      existingComments: await listComments({
        client,
        context,
        prNumber,
        commentContext,
        commentHeader: generateCommentHeader({ commentContext }),
      }),
    });

    const status = generateStatus({
      targetUrl: prUrl,
      metric,
      statusContext,
      originalMetric,
    });
    const { state, description } = status;
    if (status.state === "failure") {
      core.setFailed(status.description);
    } else {
      core.setOutput("coverage", description);
    }
  } catch (e) {
    core.setFailed(e.message);
  }
}

run().catch((e) => core.setFailed(e.message));
