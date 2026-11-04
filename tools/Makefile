# Build lại helper NetSDK:  make -C tools
CC      ?= gcc
CFLAGS  ?= -O2 -Wall
SDK     := ../sdk
TARGET  := ../bin/dahua-pb

$(TARGET): dahua-pb.c
	$(CC) $(CFLAGS) -o $@ $< -I $(SDK)/include -L $(SDK)/lib -ldhnetsdk \
		-Wl,-rpath,'$$ORIGIN/../sdk/lib'

clean:
	rm -f $(TARGET)

.PHONY: clean
