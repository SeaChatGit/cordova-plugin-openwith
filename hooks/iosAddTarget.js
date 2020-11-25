const fs = require("fs");
const path = require("path");

const {
  PLUGIN_ID,
  iosFolder,
  getPreferences,
  findXCodeproject,
  replacePreferencesInFile,
  log,
  redError,
} = require("./utils");

// Return the list of files in the share extension project, organized by type
const FILE_TYPES = {
  ".h": "source",
  ".m": "source",
  ".plist": "config",
  ".entitlements": "config",
};

function parsePbxProject(context, pbxProjectPath) {
  var xcode = require("xcode");
  log(`Parsing existing project at location: ${pbxProjectPath}…`);

  var pbxProject;

  if (context.opts.cordova.project) {
    pbxProject = context.opts.cordova.project.parseProjectFile(
      context.opts.projectRoot
    ).xcode;
  } else {
    pbxProject = xcode.project(pbxProjectPath);
    pbxProject.parseSync();
  }

  return pbxProject;
}

function forEachShareExtensionFile(context, callback) {
  var shareExtensionFolder = path.join(iosFolder(context), "ShareExtension");
  fs.readdirSync(shareExtensionFolder).forEach(function (name) {
    // Ignore junk files like .DS_Store
    if (!/^\..*/.test(name)) {
      callback({
        name: name,
        path: path.join(shareExtensionFolder, name),
        extension: path.extname(name),
      });
    }
  });
}

function getShareExtensionFiles(context) {
  var files = { source: [], config: [], resource: [] };

  forEachShareExtensionFile(context, function (file) {
    var fileType = FILE_TYPES[file.extension] || "resource";
    files[fileType].push(file);
  });

  return files;
}

function getPreferenceValue(configXml, name) {
  var value = configXml.match(
    new RegExp('name="' + name + '" value="(.*?)"', "i")
  );
  if (value && value[1]) {
    return value[1];
  } else {
    return null;
  }
}

function getCordovaParameter(configXml, variableName) {
  var variable = packageJson.cordova.plugins[PLUGIN_ID][variableName];
  if (!variable) {
    variable = getPreferenceValue(configXml, variableName);
  }
  return variable;
}

module.exports = function (context) {
  log("Adding ShareExt target to XCode project");

  var deferral = require("q").defer();
  packageJson = require(path.join(context.opts.projectRoot, "package.json"));

  var configXml = fs.readFileSync(
    path.join(context.opts.projectRoot, "config.xml"),
    "utf-8"
  );
  if (configXml) {
    configXml = configXml.substring(configXml.indexOf("<"));
  }

  findXCodeproject(context, function (projectFolder, projectName) {
    var preferences = getPreferences(context, projectName);

    var pbxProjectPath = path.join(projectFolder, "project.pbxproj");
    var pbxProject = parsePbxProject(context, pbxProjectPath);

    var files = getShareExtensionFiles(context);
    files.config.concat(files.source).forEach(function (file) {
      replacePreferencesInFile(file.path, preferences);
    });

    // Find if the project already contains the target and group
    var target =
      pbxProject.pbxTargetByName("ShareExt") ||
      pbxProject.pbxTargetByName('"ShareExt"');
    if (target) {
      log("ShareExt target already exists");
    }

    if (!target) {
      // Add PBXNativeTarget to the project
      target = pbxProject.addTarget(
        "ShareExt",
        "app_extension",
        "ShareExtension"
      );

      // Add a new PBXSourcesBuildPhase for our ShareViewController
      // (we can't add it to the existing one because an extension is kind of an extra app)
      pbxProject.addBuildPhase(
        [],
        "PBXSourcesBuildPhase",
        "Sources",
        target.uuid
      );

      // Add a new PBXResourcesBuildPhase for the Resources used by the Share Extension
      // (MainInterface.storyboard)
      pbxProject.addBuildPhase(
        [],
        "PBXResourcesBuildPhase",
        "Resources",
        target.uuid
      );
    }

    // Create a separate PBXGroup for the shareExtensions files, name has to be unique and path must be in quotation marks
    var pbxGroupKey = pbxProject.findPBXGroupKey({ name: "ShareExtension" });
    if (pbxGroupKey) {
      log("ShareExtension group already exists");
    } else {
      pbxGroupKey = pbxProject.pbxCreateGroup(
        "ShareExtension",
        "ShareExtension"
      );

      // Add the PbxGroup to cordovas "CustomTemplate"-group
      var customTemplateKey = pbxProject.findPBXGroupKey({
        name: "CustomTemplate",
      });
      pbxProject.addToPbxGroup(pbxGroupKey, customTemplateKey);
    }

    // Add files which are not part of any build phase (config)
    files.config.forEach(function (file) {
      pbxProject.addFile(file.name, pbxGroupKey);
    });

    // Add source files to our PbxGroup and our newly created PBXSourcesBuildPhase
    files.source.forEach(function (file) {
      pbxProject.addSourceFile(file.name, { target: target.uuid }, pbxGroupKey);
    });

    //  Add the resource file and include it into the targest PbxResourcesBuildPhase and PbxGroup
    files.resource.forEach(function (file) {
      pbxProject.addResourceFile(
        file.name,
        { target: target.uuid },
        pbxGroupKey
      );
    });

    // Add build settings for Swift support, bridging header and xcconfig files
    var configurations = pbxProject.pbxXCBuildConfigurationSection();
    for (var key in configurations) {
      if (typeof configurations[key].buildSettings !== "undefined") {
        var buildSettingsObj = configurations[key].buildSettings;
        if (typeof buildSettingsObj["PRODUCT_NAME"] !== "undefined") {
          var productName = buildSettingsObj["PRODUCT_NAME"];
          if (productName.indexOf("ShareExt") >= 0) {
            buildSettingsObj["CODE_SIGN_ENTITLEMENTS"] =
              '"ShareExtension/ShareExtension.entitlements"';
          }
        }
      }
    }

    //Add development team and provisioning profile
    var PROVISIONING_PROFILE = getCordovaParameter(
      configXml,
      "PROVISIONING_PROFILE"
    );
    var DEVELOPMENT_TEAM = getCordovaParameter(configXml, "DEVELOPMENT_TEAM");
    console.log(
      "Adding team",
      DEVELOPMENT_TEAM,
      "and provisioning profile",
      PROVISIONING_PROFILE
    );
    if (DEVELOPMENT_TEAM) {
      var configurations = pbxProject.pbxXCBuildConfigurationSection();
      for (var key in configurations) {
        if (typeof configurations[key].buildSettings !== "undefined") {
          var buildSettingsObj = configurations[key].buildSettings;
          if (typeof buildSettingsObj["PRODUCT_NAME"] !== "undefined") {
            var productName = buildSettingsObj["PRODUCT_NAME"];
            if (productName.indexOf("ShareExt") >= 0) {
              if (!process.env.IS_DEBUG) {
                buildSettingsObj["PROVISIONING_PROFILE"] = PROVISIONING_PROFILE;
              }
              buildSettingsObj["DEVELOPMENT_TEAM"] = DEVELOPMENT_TEAM;
              console.log(
                "Update DEVELOPMENT_TEAM= " +
                  buildSettingsObj["DEVELOPMENT_TEAM"]
              );
              buildSettingsObj[
                "PRODUCT_BUNDLE_IDENTIFIER"
              ] = getCordovaParameter(configXml, "SHARE_BUNDLE_IDENTIFIER");
              console.log(
                `Added signing identities for extension to ${productName}!`
              );
              console.log(buildSettingsObj);
              console.log(
                "Current CODE_SIGN_IDENTITY= " +
                  buildSettingsObj["CODE_SIGN_IDENTITY"]
              );
              if (!process.env.IS_DEBUG) {
                buildSettingsObj["CODE_SIGN_IDENTITY"] =
                  '"iPhone Distribution"';
                buildSettingsObj["CODE_SIGN_STYLE"] = "Manual";
              } else {
                buildSettingsObj["CODE_SIGN_STYLE"] = "Automatic";
              }
              console.log(
                "Update to distribution provision. CODE_SIGN_IDENTITY= " +
                  buildSettingsObj["CODE_SIGN_IDENTITY"]
              );
              console.log(
                "Update CODE_SIGN_STYLE= " + buildSettingsObj["CODE_SIGN_STYLE"]
              );
              console.log(
                "Update PRODUCT_BUNDLE_IDENTIFIER= " +
                  buildSettingsObj["PRODUCT_BUNDLE_IDENTIFIER"]
              );
              console.log(
                "[ShareExtension] buildSettingsObj is " +
                  JSON.stringify(buildSettingsObj)
              );
            }
          }
        }
      }
    }

    // Write the modified project back to disc
    fs.writeFileSync(pbxProjectPath, pbxProject.writeSync());
    log(
      `Successfully added ShareExt target to XCode project: ${process.env.IS_DEBUG}`
    );

    deferral.resolve();
  });

  return deferral.promise;
};
