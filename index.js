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

  return metric;
}

function generateBadgeUrl(metric) {
  return `https://img.shields.io/static/v1?label=coverage&message=${Math.round(
    metric.lines.rate
  )}%&color=${metric.level}`;
}

function generateEmoji(metric) {
  return metric.lines.rate === 100 ? " 🎉" : "";
}

function generateInfo({ rate, total, covered }) {
  return `${rate}% ( ${covered} / ${total} )`;
}

function generateCommentHeader({ commentContext }) {
  return `<!-- coverage-monitor-action: ${commentContext} -->`;
}

function generateTable({ metric, commentContext }) {
  return `${generateCommentHeader({ commentContext })}
## ${commentContext}${generateEmoji(metric)}
|  Totals | ![Coverage](${generateBadgeUrl(metric)}) |
| :-- | --: |
| Statements: | ${generateInfo(metric.lines)} |
| Methods: | ${generateInfo(metric.methods)} |
`;
}

function generateStatus({
  metric: {
    lines: { lineRate },
    statements: { statementsRate },
    methods: { methodsRate },
    branches: { branchesRate },
  },
  targetUrl,
  statusContext,
  originalMetric,
}) {
  if (originalMetric) {
    const {
      lines: { originalLineRate },
      statements: { originalStatementsRate },
      methods: { originalMethodsRate },
      branches: { originalBranchesRate },
    } = originalMetric;
    if (
      originalBranchesRate > branchesRate ||
      originalLineRate > lineRate ||
      originalMethodsRate > methodsRate ||
      originalStatementsRate > lineRate
    ) {
      let description = "Failure: ";
      if (originalBranchesRate > branchesRate) {
        description += `\nBranches Coverage decrease - ${
          originalBranchesRate - branchesRate
        }%`;
      }
      if (originalLineRate > lineRate) {
        description += `\nLine Coverage decrease - ${
          originalLineRate - lineRate
        }%`;
      }
      if (originalMethodsRate > methodsRate) {
        description = `\nMethods Coverage decrease - ${
          originalMethodsRate - methodsRate
        }%`;
      }
      if (originalStatementsRate > statementsRate) {
        description += `\nStatements Coverage decrease - ${
          originalStatementsRate - statementsRate
        }%`;
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
    description: `Success: \nLine Coverage - ${lineRate}%,\nStatement Coverage - ${statementsRate}%,\nMethods Coverage - ${methodsRate}%,\Branchs Coverage - ${branchesRate}%`,
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
  const githubToken = getInput("github_token", { required: true });
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

async function run() {
  try {
    const { context = {} } = github || {};
    const { prNumber, prUrl, sha } = parseWebhook(context);
    const { githubToken, cloverFile, statusContext, originalCloverFile } =
      loadConfig(core);
    if (core.isDebug()) {
      core.debug("Handle webhook request");
      console.log(context);
    }

    const client = github.getOctokit(githubToken);

    const coverage = await readFile(cloverFile);
    const metric = readMetric(coverage);
    let originalMetric = readMetric(coverage);
    if (fs.existsSync(originalCloverFile)) {
      const originCoverage = await readFile(cloverFile);
      originalMetric = readMetric(originCoverage);
    }

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
      core.setOutput(description);
    }
  } catch (e) {
    core.setFailed(error.message);
  }
}

run().catch((error) => core.setFailed(error.message));
