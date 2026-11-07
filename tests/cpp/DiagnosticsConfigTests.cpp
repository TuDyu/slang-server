// SPDX-FileCopyrightText: Hudson River Trading
// SPDX-License-Identifier: MIT

#include "Config.h"
#include "utils/ServerHarness.h"
#include <algorithm>
#include <catch2/catch_test_macros.hpp>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>

#include "slang/util/ScopeGuard.h"

namespace fs = std::filesystem;
using namespace server;

namespace {

constexpr const char* kUnusedSource =
    "module top;\n    int unused_thing;\n    initial begin\n    end\nendmodule\n";

std::vector<lsp::Diagnostic> unusedDiagnostics(ServerHarness& server) {
    auto doc = server.openFile("warn.sv", kUnusedSource);
    return doc.getDiagnostics();
}

Config withDiagnostics(std::function<void(Config::Diagnostics&)> configure) {
    Config config;
    configure(config.diagnostics.value());
    return config;
}

} // namespace

TEST_CASE("diagnostics.ignore suppresses one warning") {
    ServerHarness server;
    auto config = withDiagnostics(
        [](Config::Diagnostics& diagnostics) { diagnostics.ignore.value() = {"unused-variable"}; });
    REQUIRE(server.loadConfig(config, true));

    auto diagnostics = unusedDiagnostics(server);
    CAPTURE(diagnostics.size());
    const bool noDiagnostics = diagnostics.empty();
    CHECK(noDiagnostics);
}

TEST_CASE("diagnostics.warnings none suppresses all warnings") {
    ServerHarness server;
    auto config = withDiagnostics([](Config::Diagnostics& diagnostics) {
        diagnostics.warnings = Config::Diagnostics::WarningSet::none;
    });
    REQUIRE(server.loadConfig(config, true));

    auto diagnostics = unusedDiagnostics(server);
    CAPTURE(diagnostics.size());
    const bool noDiagnostics = diagnostics.empty();
    CHECK(noDiagnostics);
}

TEST_CASE("diagnostics.severity upgrades a warning to an error") {
    ServerHarness server;
    auto config = withDiagnostics([](Config::Diagnostics& diagnostics) {
        diagnostics.severity.value()["unused-variable"] = "error";
    });
    REQUIRE(server.loadConfig(config, true));

    auto diagnostics = unusedDiagnostics(server);
    REQUIRE(diagnostics.size() == 1);
    REQUIRE(diagnostics[0].severity.has_value());
    CHECK(*diagnostics[0].severity == lsp::DiagnosticSeverity::Error);
}

TEST_CASE("diagnostics.severity downgrades a warning to a hint") {
    ServerHarness server;
    auto config = withDiagnostics([](Config::Diagnostics& diagnostics) {
        diagnostics.severity.value()["unused-variable"] = "hint";
    });
    REQUIRE(server.loadConfig(config, true));

    auto diagnostics = unusedDiagnostics(server);
    REQUIRE(diagnostics.size() == 1);
    REQUIRE(diagnostics[0].severity.has_value());
    CHECK(*diagnostics[0].severity == lsp::DiagnosticSeverity::Hint);
}

TEST_CASE("diagnostics.suppressPaths suppresses warnings for an absolute path") {
    ServerHarness server;
    auto warnPath = (findSlangRoot() / "warn.sv").string();
    auto config = withDiagnostics(
        [&](Config::Diagnostics& diagnostics) { diagnostics.suppressPaths.value() = {warnPath}; });
    REQUIRE(server.loadConfig(config, true));

    auto diagnostics = unusedDiagnostics(server);
    CAPTURE(diagnostics.size());
    const bool noDiagnostics = diagnostics.empty();
    CHECK(noDiagnostics);
}

TEST_CASE("diagnostics.suppressPaths resolves relative patterns against the workspace") {
    const auto unique = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    auto root = fs::temp_directory_path() / ("slang_diag_suppress_" + unique);
    fs::create_directories(root / ".slang");
    auto cleanup = slang::ScopeGuard([&] {
        std::error_code ec;
        fs::remove_all(root, ec);
    });
    {
        std::ofstream(root / "warn.sv") << kUnusedSource;
        std::ofstream(root / ".slang" / "server.json")
            << R"({"diagnostics": {"suppressPaths": ["warn.sv"]}})";
    }

    ServerHarness server(lsp::InitializeParams{
        .workspaceFolders = {{lsp::WorkspaceFolder{URI::fromFile(root), "config"}}}});
    auto doc = server.openFile("warn.sv");

    const bool noDiagnostics = doc.getDiagnostics().empty();
    CHECK(noDiagnostics);
}

TEST_CASE("flags -Wnone disables every warning") {
    ServerHarness server;
    Config config;
    config.flagsByFile.value() = {{"test", "-Wnone"}};
    REQUIRE(server.loadConfig(config, true));

    auto diagnostics = unusedDiagnostics(server);
    CAPTURE(diagnostics.size());
    const bool noDiagnostics = diagnostics.empty();
    CHECK(noDiagnostics);
}

TEST_CASE("flags -Wno-<name> still suppresses only that warning") {
    ServerHarness server;
    Config config;
    config.flagsByFile.value() = {{"test", "-Wno-unused-variable"}};
    REQUIRE(server.loadConfig(config, true));

    auto diagnostics = unusedDiagnostics(server);
    CAPTURE(diagnostics.size());
    const bool noDiagnostics = diagnostics.empty();
    CHECK(noDiagnostics);
}

TEST_CASE("diagnostics config merges across the config files") {
    const auto unique = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    auto root = fs::temp_directory_path() / ("slang_diag_cfg_" + unique);
    fs::create_directories(root);
    auto cleanup = slang::ScopeGuard([&] {
        std::error_code ec;
        fs::remove_all(root, ec);
    });

    auto write = [&](const char* name, const char* text) {
        std::ofstream out(root / name);
        out << text;
    };

    write("workspace.json", R"({
        "diagnostics": {
            "warnings": "all",
            "ignore": ["unused-variable"],
            "severity": {"implicit-conv": "error"}
        }
    })");
    write("user.json", R"({
        "diagnostics": {
            "warnings": "none",
            "ignore": ["width-trunc"],
            "severity": {"unused-net": "hint"}
        }
    })");

    auto config = Config::fromFiles((root / "workspace.json").string(),
                                    (root / "user.json").string(), std::nullopt);
    REQUIRE(config);

    const auto& diagnostics = config->diagnostics.value();
    // Scalars are overridden by the later file, lists are appended, and maps merge.
    CHECK(diagnostics.warnings.value() == Config::Diagnostics::WarningSet::none);
    CHECK(diagnostics.ignore.value() == std::vector<std::string>{"unused-variable", "width-trunc"});
    CHECK(diagnostics.severity.value().size() == 2);
    CHECK(diagnostics.severity.value().at("implicit-conv") == "error");
    CHECK(diagnostics.severity.value().at("unused-net") == "hint");
}

TEST_CASE("diagnostic catalog lists configurable warnings") {
    ServerHarness server;
    auto catalog = server.getConfigCatalog({});

    CHECK(catalog.diagnostics.size() > 200);
    CHECK_FALSE(catalog.workspaceFile.has_value());

    auto entry = std::ranges::find_if(catalog.diagnostics, [](const auto& option) {
        return option.code == "unused-variable";
    });
    REQUIRE(entry != catalog.diagnostics.end());
    CHECK(entry->subsystem == "Analysis");
    CHECK(entry->description == "unused variable '{}'");

    const bool hasUnusedGroup = std::ranges::find(entry->groups, std::string("unused")) !=
                                entry->groups.end();
    CHECK(hasUnusedGroup);

    // Sorted by option name so clients can present a stable list.
    bool sorted = true;
    for (size_t i = 1; i < catalog.diagnostics.size(); ++i) {
        if (catalog.diagnostics[i - 1].code > catalog.diagnostics[i].code) {
            sorted = false;
            break;
        }
    }
    CHECK(sorted);
}
