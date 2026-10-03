# Source patches for the wasm SDK. Run in the unpacked source directory:
#   cmake -P patch.cmake <openusd|materialx|prune> [prefix]
# Each replacement fails loudly when its pattern is gone, so a version bump
# cannot silently drop a patch.

function(replace file from to)
    file(READ "${file}" text)
    string(FIND "${text}" "${to}" done)
    if(NOT done EQUAL -1)
        return() # already patched
    endif()
    string(FIND "${text}" "${from}" at)
    if(at EQUAL -1)
        message(FATAL_ERROR "patch.cmake: pattern not found in ${file}:\n${from}")
    endif()
    string(REPLACE "${from}" "${to}" text "${text}")
    file(WRITE "${file}" "${text}")
endfunction()

set(what "${CMAKE_ARGV3}")

if(what STREQUAL "openusd")
    # hgi has no CMake gate and no Emscripten branch; with GPU support off
    # the factory just returns null.
    replace(pxr/imaging/hgi/hgi.cpp
        "#error Unknown Platform"
        "// (wasm SDK) no Hgi backend on this platform")
    # WIN32 is false when cross compiling to Emscripten on a Windows host,
    # which leaves drive-letter paths in a ':' separated list.
    replace(pxr/usd/usdMtlx/CMakeLists.txt
        "if (WIN32)"
        "if (WIN32 OR CMAKE_HOST_WIN32)")
elseif(what STREQUAL "materialx")
    # The Emscripten toolchain sets UNIX, so the X11 lookup would fire.
    replace(cmake/modules/MaterialXConfig.cmake.in
        "if(UNIX AND NOT APPLE)"
        "if(UNIX AND NOT APPLE AND NOT EMSCRIPTEN)")
elseif(what STREQUAL "prune")
    set(prefix "${CMAKE_ARGV4}")
    file(GLOB gen "${prefix}/libraries/*/gen*" "${prefix}/libraries/targets")
    if(gen)
        file(REMOVE_RECURSE ${gen})
    endif()
else()
    message(FATAL_ERROR "patch.cmake: unknown target '${what}'")
endif()
