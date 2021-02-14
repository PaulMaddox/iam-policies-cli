const axios = require("axios");
const effects = ["Allow", "Deny"];
const inquirer = require("inquirer");
const templateParser = require("./template-parser");
const input = require("./input-helper");
const fs = require("fs");
const YAML = require("./yaml-wrapper");
const clipboard = require("clipboardy");
let templateFormat;

async function start(templatePath, format, output) {
  let template = getTemplate(templatePath);
  format = templateFormat || format;
  const serializer = format.toLowerCase().startsWith("y") ? YAML : JSON;
  let policies = await getPolices();

  const suggestedServices = templateParser.suggestedServices(
    template,
    policies
  );

  const document = {
    Version: "2012-10-17",
    Statement: [],
  };
  let addStatement;
  let lastARN = "";
  policies.sort((a, b) => (a.name > b.name ? 1 : -1));
  do {
    const selectedService = await selectService(
      template,
      suggestedServices,
      policies
    );
    const actions = await selectActions(selectedService);
    const effect = await selectEffect();

    let resources = null;
    resources = [];
    if (selectedService.HasResource) {
      lastARN = await inputArn(template, selectedService, lastARN, resources);
    }

    const conditionsInput = await input.confirm(`Add conditions?`, false);

    let conditions;
    if (conditionsInput) {
      conditions = await selectConditions(
        conditions,
        policies,
        selectedService
      );
    }

    document.Statement.push({
      Sid: `Statement${document.Statement.length + 1}`,
      Effect: effect,
      Action: actions.map((p) => `${selectedService.StringPrefix}:${p}`),
      Resource: resources || null,
      Condition: conditions,
    });

    if (output.toLowerCase() === "console") {
      console.log("Generated policy:");
      console.log("*****************");
      console.log(
        serializer.stringify(JSON.parse(JSON.stringify(document)), null, 2)
      );
    } else {
      clipboard.writeSync(serializer.stringify(document, null, 2));
    }

    addStatement = await input.list("Please select", ["Add statement", "done"]);
  } while (addStatement !== "done");
}

async function selectConditions(conditions, policies, selectedService) {
  conditions = {};
  do {
    const operator = await input.list(
      `Select condition operator`,
      policies.conditionOperators
    );
    conditions[operator] = {};
    let key = await input.list(`Select condition key`, [
      ...(selectedService.conditionKeys || []),
      ...policies.conditionKeys,
    ]);
    if (key.indexOf("${TagKey}") > 0) {
      const tagKey = await input.text(`Input tag name`);
      key = key.replace("${TagKey}", tagKey);
    }
    const value = await input.text(`Input condition value`);
    conditions[operator][key] = value;
  } while (await input.confirm(`Add more conditions?`));
  return conditions;
}

async function inputArn(template, selectedService, lastARN, resources) {
  do {
    let arn;
    let isTemplateResource = false;
    if (template) {
      const templateResource = await input.list("Select resource ARN from", [
        "Template",
        "Free text",
      ]);
      if (templateResource === "Template") {
        const resources = templateParser.getResources(
          template,
          selectedService.StringPrefix
        );
        const res = await input.list("Select resource", [
          new inquirer.Separator("--- Matching resources ---"),
          ...resources.matching,
          new inquirer.Separator("--- Other resources ---"),
          ...resources.all,
        ]);
        const split = res.split(" ");
        arn = templateParser.getRefResolver(split[0], split[1]);
        isTemplateResource = true;
      }
    }
    arn = arn || (await input.text("Input ARN", lastARN));
    const regexp = RegExp(selectedService.ARNRegex);
    let addArn = true;
    if (!isTemplateResource && !regexp.test(arn)) {
      addArn = await input.confirm("Invalid ARN. Add anyway?");
    }
    if (addArn) {
      resources.push(arn);
    }
    lastARN = arn;
  } while (await input.confirm("Add more resources?", false));
  return lastARN;
}

async function selectEffect() {
  return await input.list(`Select effect`, effects);
}

async function selectActions(selectedService) {
  let actions = [];
  do {
    actions = await input.checkbox(`Add action(s)`, selectedService.Actions);
    if (actions.length === 0) {
      console.log("Please select at leats one action");
    }
  } while (actions.length === 0);
  return actions;
}

async function selectService(template, suggestedServices, policies) {
  let serviceName;
  if (template) {
    serviceName = await input.list(`Build statement for`, [
      suggestedServices.length
        ? new inquirer.Separator(
            "--- Suggested services based on CloudFormation template ---"
          )
        : [],
      ...suggestedServices,
      new inquirer.Separator("--- All services ---"),
      ...policies,
    ]);
  } else {
    serviceName = await input.list(`Build statement for`, policies);
  }
  return serviceName;
}

async function getPolices() {
  const policiesResponse = await axios.get(
    "https://awspolicygen.s3.amazonaws.com/js/policies.js"
  );
  const policies = JSON.parse(
    policiesResponse.data.replace("app.PolicyEditorConfig=", "")
  ); // Make it JSON parseable

  return Object.keys(policies.serviceMap).map((p) => {
    const item = policies.serviceMap[p];
    const niceName = p.replace(/^AWS /, "").replace(/^Amazon /, "");
    return {
      name: niceName,
      value: { ...item, name: niceName },
    };
  });
}

function getTemplate(templatePath) {
  let template = null;
  if (fs.existsSync(templatePath)) {
    const file = fs.readFileSync(templatePath).toString();
    try {
      template = JSON.parse(file);
      templateFormat = "json";
    } catch (err) {
      template = YAML.parse(file);
      templateFormat = "yaml";
    }
  }

  return template;
}

module.exports = {
  start,
};
