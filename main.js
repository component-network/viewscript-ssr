const { readFile } = require("fs/promises");
const { resolve } = require("path");
const { JSDOM } = require("jsdom");
const YAML = require("yaml");

const componentFsCache = new Map();

function applyDataToDomElement(domElement, imports, data) {
  // Repeat elements with a use-for attribute
  const rootRepeaters = domElement.querySelectorAll("[use-for]");

  for (const repeater of rootRepeaters) {
    const [itemName, collectionName] = repeater
      .getAttribute("use-for")
      .split(" in ");

    const collectionData = getNestedValue(data, collectionName);

    repeater.removeAttribute("use-for");

    for (const item of collectionData) {
      const clonedElement = repeater.cloneNode(true);

      applyDataToDomElement(clonedElement, imports, {
        ...data,
        [itemName]: item,
      });

      repeater.insertAdjacentElement("beforebegin", clonedElement);
    }

    repeater.remove();
  }

  // Remove elements with a use-if attribute that evaluates to false
  const rootOptionals = domElement.querySelectorAll("[use-if]");

  for (const optional of rootOptionals) {
    const optionalName = optional.getAttribute("use-if");
    const inverted = optionalName.startsWith("!");
    const boundOptionalName = inverted ? optionalName.slice(1) : optionalName;
    const optionalValue = getNestedValue(data, boundOptionalName);

    if ((optionalValue && !inverted) || (!optionalValue && inverted)) {
      optional.removeAttribute("use-if");
    } else {
      optional.remove();
    }
  }

  // Replace slot elements with the data provided
  const rootSlots = domElement.querySelectorAll("slot");

  for (const slot of rootSlots) {
    const slotName = slot.getAttribute("name");

    if (slotName) {
      const slotData = getNestedValue(data, slotName);

      if (slotData != null) {
        slot.replaceWith(slotData);
      }
    }
  }

  applyDataToDomElementAttributes(domElement, imports, data);
}

function applyDataToDomElementAttributes(domElement, imports, data) {
  const attributes = Array.from(domElement.attributes || []);

  for (const attribute of attributes) {
    if (attribute.name.startsWith(":")) {
      const targetAttributeName = attribute.name.slice(1);
      const targetAttributeValue = getNestedValue(data, attribute.value);

      const targetAttributeValueSerialized = Object.keys(imports).some(
        (importKey) => importKey.toUpperCase() === domElement.tagName
      )
        ? JSON.stringify(targetAttributeValue)
        : targetAttributeValue;

      if (targetAttributeValueSerialized != null) {
        domElement.setAttribute(
          targetAttributeName,
          targetAttributeValueSerialized
        );
      }

      domElement.removeAttribute(attribute.name);
    }
  }

  for (const child of domElement.children) {
    applyDataToDomElementAttributes(child, imports, data);
  }
}

function getNestedValue(obj, path) {
  return path?.split(".").reduce((acc, key) => acc?.[key], obj);
}

exports.getComponentFromFs = async function getComponentFromFs(
  componentDir,
  options = {}
) {
  const { baseDir = "", cacheOptions = {} } = options;

  if (cacheOptions.enabled) {
    const cachedComponent = componentFsCache.get(componentDir);

    if (cachedComponent) {
      console.log(
        "[viewscript-ssr] getComponentFromFs cache hit  for",
        componentDir
      );

      return cachedComponent;
    }

    console.log(
      "[viewscript-ssr] getComponentFromFs cache miss for",
      componentDir
    );
  }

  const templateFilePath = resolve(baseDir, componentDir, "template.html");
  const settingsFilePath = resolve(baseDir, componentDir, "settings.yaml");

  const [componentTemplate, componentSettingsSource] = await Promise.all([
    readFile(templateFilePath, "utf8"),
    readFile(settingsFilePath, "utf8"),
  ]);

  const componentSettings = YAML.parse(componentSettingsSource);
  const component = { componentSettings, componentTemplate };

  if (cacheOptions.enabled) {
    componentFsCache.set(componentDir, component);
  }

  return component;
};

exports.renderComponent = async function renderComponent(
  componentUri,
  customData,
  context
) {
  const { componentSettings, componentTemplate } = await context.getComponent(
    componentUri,
    context.getComponentOptions
  );

  const componentDom = new JSDOM(componentTemplate);

  applyDataToDomElement(
    componentDom.window.document,
    componentSettings.imports,
    {
      ...componentSettings.data,
      ...customData,
    }
  );

  // TODO Each imported component should render in a template with a shadow root
  // TODO Refactor component imports to use document.querySelectorAll instead of DFS

  const componentImportKeys = Object.keys(componentSettings.imports);

  await (async function interpolate(children) {
    for (const child of children) {
      await interpolate(child.children);

      const tagName = child.tagName.toLowerCase();

      const matchingImportKey = componentImportKeys.find(
        (importKey) => importKey.toLowerCase() === tagName
      );

      if (matchingImportKey) {
        const attributes = Array.from(child.attributes).reduce(
          (result, attribute) => {
            result[attribute.name] = JSON.parse(attribute.value);
            return result;
          },
          {}
        );

        const importDir =
          typeof componentSettings.imports[matchingImportKey] === "string"
            ? componentSettings.imports[matchingImportKey]
            : String(componentSettings.imports[matchingImportKey]);

        const importRendering = await renderComponent(
          importDir,
          attributes, // parse before passing to renderComponent
          context
        );

        const importDom = new JSDOM(importRendering);
        const slots = importDom.window.document.querySelectorAll("slot");

        for (const slot of slots) {
          if (slot.hasAttribute("name")) {
            const matchingChild = Array.from(child.children).find(
              (child) =>
                child.getAttribute("slot") === slot.getAttribute("name")
            );

            if (matchingChild) {
              slot.replaceWith(matchingChild);
            }
          } else {
            slot.replaceWith(...child.childNodes);
          }
        }

        await interpolate(importDom.window.document.body.children);

        child.replaceWith(...importDom.window.document.body.childNodes);
      }
    }
  })(componentDom.window.document.documentElement.children);

  // TODO Apply Tailwind CSS using PostCSS, if the tailwindcss plugin is enabled
  // TODO Support dot class name syntax

  const serializedDom = componentDom.serialize();

  return serializedDom;
};
