KVER ?= $(shell uname -r)
KDIR ?= /lib/modules/$(KVER)/build

obj-m += ov02c10.o

all:
	$(MAKE) -C $(KDIR) M=$(CURDIR) modules
clean:
	$(MAKE) -C $(KDIR) M=$(CURDIR) clean
