# The wasm core: usdcore.js + usdcore.wasm.
#
#   emsdk_env first, then:
#   emcmake cmake -S native -B <build> -G Ninja -DSDK_PREFIX=<prefix built by sdk/>
#   cmake --build <build>
cmake_minimum_required(VERSION 3.27)
project(usdcore CXX)

set(SDK_PREFIX "" CACHE PATH "Prefix of the wasm SDK built by sdk/")
if(NOT EXISTS "${SDK_PREFIX}/pxrConfig.cmake")
    message(FATAL_ERROR "SDK_PREFIX must point at the SDK built by sdk/ (no pxrConfig.cmake in '${SDK_PREFIX}')")
endif()
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# The Emscripten toolchain only searches its own sysroot unless told otherwise.
list(APPEND CMAKE_PREFIX_PATH "${SDK_PREFIX}")
list(APPEND CMAKE_FIND_ROOT_PATH "${SDK_PREFIX}")
set(MaterialX_DIR "${SDK_PREFIX}/lib/cmake/MaterialX")
set(TBB_DIR "${SDK_PREFIX}/lib/cmake/TBB")
set(pxr_DIR "${SDK_PREFIX}")
find_package(pxr REQUIRED)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(usdcore
    src/bindings.cpp
    src/geometry.cpp
    src/sceneBridge.cpp
    src/stage.cpp
    src/webResolver.cpp
)
# Thread and exception models must match the SDK's.
target_compile_options(usdcore PRIVATE -pthread -fexceptions)

# The USD libraries are linked by hand instead of through their imported targets:
#  - Whole archives: USD registers types, schemas and plugins from static
#    initialisers the linker would otherwise discard as unreferenced.
#  - Each archive exactly once: CMake repeats static libraries to satisfy
#    dependency order, and a repeated whole archive defines every symbol twice.
#  - Without the targets' link options: they carry one --embed-file per resource
#    file, hundreds in total, which overflows the Windows command line. The
#    resource directory is embedded once below instead.
set(archives)
foreach(lib ${PXR_LIBRARIES})
    target_link_libraries(usdcore PRIVATE $<COMPILE_ONLY:${lib}>)
    list(APPEND archives $<TARGET_FILE:${lib}>)
endforeach()
target_link_options(usdcore PRIVATE -Wl,--whole-archive ${archives} -Wl,--no-whole-archive)
target_link_libraries(usdcore PRIVATE TBB::tbb MaterialXFormat MaterialXCore OpenSubdiv::osdCPU_static)

target_link_options(usdcore PRIVATE
    -pthread -fexceptions -lembind -lworkerfs.js --no-entry
    -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=worker,node
    -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB
    # USD recurses deeply (composition, value parsing); the 64 KB default overflows silently.
    -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB
    -sPTHREAD_POOL_SIZE=8
    -sFETCH -sFETCH_SUPPORT_INDEXEDDB=0
    -sEXPORTED_RUNTIME_METHODS=FS
    "SHELL:--embed-file ${SDK_PREFIX}/lib/usd@/usd"
    "SHELL:--embed-file ${CMAKE_CURRENT_SOURCE_DIR}/plugInfo.json@/usd/webResolver/resources/plugInfo.json"
)
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_link_options(usdcore PRIVATE -sASSERTIONS=1 -sSTACK_OVERFLOW_CHECK=2)
endif()

# The page loads the core from web/public/core/.
add_custom_command(TARGET usdcore POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE_DIR:usdcore>/usdcore.js $<TARGET_FILE_DIR:usdcore>/usdcore.wasm
        ${CMAKE_CURRENT_SOURCE_DIR}/../web/public/core/
)
