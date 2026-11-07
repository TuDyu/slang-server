//------------------------------------------------------------------------------
// DiagnosticCatalog.cpp
// Table of slang warnings that can be configured from server configuration
//
// SPDX-FileCopyrightText: Hudson River Trading
// SPDX-License-Identifier: MIT
//------------------------------------------------------------------------------

#include "util/DiagnosticCatalog.h"

#include <algorithm>

namespace server {

namespace {
/// Generated at build time from slang's diagnostics.txt.
constexpr DiagnosticCatalogEntry kEntries[] = {
#include "DiagCatalog.inc"
};
} // namespace

std::span<const DiagnosticCatalogEntry> getDiagnosticCatalog() {
    return kEntries;
}

const DiagnosticCatalogEntry* findDiagnosticCatalogEntry(std::string_view optionName) {
    auto it = std::ranges::find_if(kEntries, [&](const DiagnosticCatalogEntry& entry) {
        return entry.optionName == optionName;
    });
    return it == std::end(kEntries) ? nullptr : &*it;
}

} // namespace server
