//------------------------------------------------------------------------------
// DiagnosticCatalog.h
// Table of slang warnings that can be configured from server configuration
//
// SPDX-FileCopyrightText: Hudson River Trading
// SPDX-License-Identifier: MIT
//------------------------------------------------------------------------------
#pragma once

#include <span>
#include <string_view>

namespace server {

/// A warning that can be controlled with -W<name>.
struct DiagnosticCatalogEntry {
    /// Name accepted by -W, e.g. "unused-variable".
    std::string_view optionName;
    /// C++ diagnostic name, e.g. "UnusedVariable".
    std::string_view name;
    /// slang subsystem that emits the warning, used for grouping in clients.
    std::string_view subsystem;
    /// Format string of the warning message.
    std::string_view description;
    /// Comma separated warning groups this warning belongs to, empty if none.
    std::string_view groups;
};

/// All configurable warnings slang knows about, in diagnostics.txt order.
std::span<const DiagnosticCatalogEntry> getDiagnosticCatalog();

/// Look up a catalog entry by its -W option name, or null when it isn't a warning.
const DiagnosticCatalogEntry* findDiagnosticCatalogEntry(std::string_view optionName);

} // namespace server
